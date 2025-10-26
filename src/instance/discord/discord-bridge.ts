import assert from 'node:assert'

import type { APIEmbed, ApplicationEmoji, Message, TextBasedChannelFields, Webhook } from 'discord.js'
import { AttachmentBuilder, ChannelType as DiscordChannelType, escapeMarkdown, hyperlink } from 'discord.js'
import type { Logger } from 'log4js'

import type { StaticDiscordConfig } from '../../application-config.js'
import type Application from '../../application.js'
import type {
  BaseInGameEvent,
  BroadcastEvent,
  ChatEvent,
  CommandEvent,
  CommandFeedbackEvent,
  GuildGeneralEvent,
  GuildPlayerEvent,
  InstanceMessage,
  InstanceMessageType,
  InstanceStatusEvent,
  MinecraftReactiveEvent
} from '../../common/application-event.js'
import {
  ChannelType,
  Color,
  GuildPlayerEventType,
  InstanceType,
  MinecraftReactiveEventType,
  PunishmentPurpose,
  PunishmentType
} from '../../common/application-event.js'
import Bridge from '../../common/bridge.js'
import type { ConfigManager } from '../../common/config-manager.js'
import { StatusVisibility } from '../../common/connectable-instance.js'
import type UnexpectedErrorHandler from '../../common/unexpected-error-handler.js'
import type { User } from '../../common/user'
import { beautifyInstanceName } from '../../utility/shared-utility'

import type { DiscordConfig } from './common/discord-config.js'
import { BlockReaction, GuildMutedReaction, RepeatReaction } from './common/discord-config.js'
import type MessageAssociation from './common/message-association.js'
import type { DiscordAssociatedMessage } from './common/message-association.js'
import MessageDeleter from './common/message-deletor.js'
import MessageToImage from './common/message-to-image.js'
import type DiscordInstance from './discord-instance.js'

export default class DiscordBridge extends Bridge<DiscordInstance> {
  public readonly messageDeleter: MessageDeleter
  private readonly messageAssociation: MessageAssociation
  private readonly messageToImage

  private readonly staticConfig: Readonly<StaticDiscordConfig>
  private readonly config: ConfigManager<DiscordConfig>

  constructor(
    application: Application,
    clientInstance: DiscordInstance,
    config: ConfigManager<DiscordConfig>,
    messageAssociation: MessageAssociation,
    logger: Logger,
    errorHandler: UnexpectedErrorHandler,
    staticDiscordConfig: StaticDiscordConfig
  ) {
    super(application, clientInstance, logger, errorHandler)

    this.config = config
    this.messageAssociation = messageAssociation
    this.staticConfig = staticDiscordConfig

    // TODO: properly reference client
    // @ts-expect-error client is private variable
    this.messageDeleter = new MessageDeleter(application, logger, errorHandler, this.clientInstance.client)
    this.messageToImage = new MessageToImage(config)

    this.application.on('instanceMessage', (event) => {
      void this.queue
        .add(async () => this.onInstanceMessageEvent(event))
        .catch(this.errorHandler.promiseCatch('handling event instanceMessage'))
    })
  }

  async onInstance(event: InstanceStatusEvent): Promise<void> {
    if (event.instanceName === this.clientInstance.instanceName) return
    if (event.visibility === StatusVisibility.Silent) return
    switch (event.instanceType) {
      case InstanceType.Commands:
      case InstanceType.Prometheus:
      case InstanceType.Metrics:
      case InstanceType.Plugin:
      case InstanceType.Utility:
      case InstanceType.Core: {
        return
      }
    }

    const config = this.config.data
    for (const channelId of config.publicChannelIds) {
      // TODO: properly reference client
      // @ts-expect-error client is private variable
      const channel = await this.clientInstance.client.channels.fetch(channelId)
      if (!channel?.isSendable()) continue

      const message = await channel.send({
        embeds: [
          {
            description:
              escapeMarkdown(beautifyInstanceName(event.instanceName)) + ' > ' + escapeMarkdown(event.message),
            color: Color.Info
          }
        ],
        allowedMentions: { parse: [] }
      })
      this.messageAssociation.addMessageId(event.eventId, {
        guildId: message.guildId ?? undefined,
        channelId: message.channelId,
        messageId: message.id
      })
    }
  }

  async onChat(event: ChatEvent): Promise<void> {
    const channels = this.resolveChannels([event.channelType])
    const username = event.user.displayName()

    for (const channelId of channels) {
      if (event.instanceType === InstanceType.Discord && channelId === event.channelId) continue

      if (event.instanceType === InstanceType.Minecraft && this.messageToImage.shouldRenderImage()) {
        const formattedMessage = this.removeGuildPrefix(event.rawMessage)
        const image = this.messageToImage.generateMessageImage(formattedMessage)
        await this.sendImageToChannels(event.eventId, [channelId], image)
      } else {
        const webhook = await this.getWebhook(channelId)

        let displayUsername =
          event.instanceType === InstanceType.Discord && event.replyUsername !== undefined
            ? `${username}⇾${event.replyUsername}`
            : username

        if (this.application.generalConfig.data.originTag) {
          displayUsername += event.instanceType === InstanceType.Discord ? ` [DC]` : ` [${event.instanceName}]`
        }

        const message = await webhook.send({
          content: escapeMarkdown(event.message),
          username: displayUsername,
          avatarURL: event.user.avatar(),
          allowedMentions: { parse: [] }
        })
        this.messageAssociation.addMessageId(event.eventId, {
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id
        })
      }
    }
  }

  async onGuildPlayer(event: GuildPlayerEvent): Promise<void> {
    if (
      event.instanceType === this.clientInstance.instanceType &&
      event.instanceName === this.clientInstance.instanceName
    )
      return

    if (event.type === GuildPlayerEventType.Online && !this.config.data.guildOnline) return
    if (event.type === GuildPlayerEventType.Offline && !this.config.data.guildOffline) return

    if (event.type === GuildPlayerEventType.Mute) {
      const game =
        event.user
          .punishments()
          .all()
          .filter((punishment) => punishment.type === PunishmentType.Mute)
          .toSorted((a, b) => b.createdAt - a.createdAt)
          .at(0)?.purpose === PunishmentPurpose.Game

      if (game) return
    }

    const removeLater = event.type === GuildPlayerEventType.Offline || event.type === GuildPlayerEventType.Online
    const username = event.user.displayName()

    let messages: Message[]
    if (this.messageToImage.shouldRenderImage()) {
      const formattedMessage = this.removeGuildPrefix(event.rawMessage)

      messages = await this.sendImageToChannels(
        event.eventId,
        this.resolveChannels(event.channels),
        this.messageToImage.generateMessageImage(formattedMessage)
      )
    } else {
      const clickableUsername = hyperlink(username, event.user.profileLink())

      const withoutPrefix = event.message.replaceAll(/^-+/g, '').replaceAll('Guild > ', '')

      const newMessage = `**${escapeMarkdown(event.instanceName)} >** ${escapeMarkdown(withoutPrefix).replaceAll(escapeMarkdown(username), clickableUsername)}`

      const embed = {
        url: event.user.profileLink(),
        description: newMessage,
        color: event.color
      } satisfies APIEmbed

      messages = await this.sendEmbedToChannels(event, this.resolveChannels(event.channels), embed)
    }

    if (removeLater) {
      this.messageDeleter.add({
        createdAt: Date.now(),
        messages: messages.map((message) => ({ channelId: message.channelId, messageId: message.id }))
      })
    }
  }

  async onGuildGeneral(event: GuildGeneralEvent): Promise<void> {
    if (
      event.instanceType === this.clientInstance.instanceType &&
      event.instanceName === this.clientInstance.instanceName
    )
      return

    if (this.messageToImage.shouldRenderImage()) {
      const image = this.messageToImage.generateMessageImage(event.rawMessage)
      await this.sendImageToChannels(event.eventId, this.resolveChannels(event.channels), image)
    } else {
      await this.sendEmbedToChannels(event, this.resolveChannels(event.channels), undefined)
    }
  }

  private lastMinecraftEvent = new Map<MinecraftReactiveEventType, number>()

  async onMinecraftChatEvent(event: MinecraftReactiveEvent): Promise<void> {
    if ((this.lastMinecraftEvent.get(event.type) ?? 0) + 5000 > Date.now()) return
    this.lastMinecraftEvent.set(event.type, Date.now())

    // TODO: properly reference client
    // @ts-expect-error client is private variable
    const client = this.clientInstance.client

    const replyIds = this.messageAssociation.getMessageId(event.originEventId)
    for (const replyId of replyIds) {
      try {
        const channel = await client.channels.fetch(replyId.channelId)
        if (channel?.type === DiscordChannelType.GuildText) {
          const message = await channel.messages.fetch(replyId.messageId)

          let emoji: ApplicationEmoji | undefined = undefined
          switch (event.type) {
            case MinecraftReactiveEventType.Repeat: {
              emoji = client.application?.emojis.cache.find((emoji) => emoji.name === RepeatReaction.name)
              break
            }
            case MinecraftReactiveEventType.Advertise:
            case MinecraftReactiveEventType.Block: {
              emoji = client.application?.emojis.cache.find((emoji) => emoji.name === BlockReaction.name)
              break
            }
            case MinecraftReactiveEventType.GuildMuted: {
              emoji = client.application?.emojis.cache.find((emoji) => emoji.name === GuildMutedReaction.name)
              break
            }
          }

          if (emoji != undefined) {
            await message.react(emoji)
            continue
          }
        }

        if (this.messageToImage.shouldRenderImage()) {
          assert.ok(channel?.isSendable())
          await channel.send({
            files: [new AttachmentBuilder(this.messageToImage.generateMessageImage(event.rawMessage))]
          })
        } else {
          await this.replyWithEmbed(event.eventId, replyId, await this.generateEmbed(event, replyId.guildId))
        }
      } catch (error: unknown) {
        this.logger.error(error, 'can not reply to message')
      }
    }
  }

  async onBroadcast(event: BroadcastEvent): Promise<void> {
    if (
      event.instanceType === this.clientInstance.instanceType &&
      event.instanceName === this.clientInstance.instanceName
    )
      return

    const channels = this.resolveChannels(event.channels)
    if (this.messageToImage.shouldRenderImage()) {
      let formatted: string
      switch (event.color) {
        case Color.Good: {
          formatted = `§a`
          break
        }
        case Color.Bad: {
          formatted = `§c`
          break
        }
        case Color.Error: {
          formatted = `§4`
          break
        }
        case Color.Info: {
          formatted = `§e`
          break
        }
        // eslint-disable-next-line unicorn/no-useless-switch-case
        case Color.Default:
        default: {
          formatted = `§b`
        }
      }
      const image = this.messageToImage.generateMessageImage(formatted + event.message)
      await this.sendImageToChannels(event.eventId, channels, image)
    } else {
      await this.sendEmbedToChannels(event, channels, undefined)
    }
  }

  private formatRenderedImage(prefix: string, message: string): string {
    return `§4§l[§c${prefix}§4§l]§f§r ${message}`
  }

  private resolveChannels(channels: ChannelType[]): string[] {
    const config = this.config.data

    const results: string[] = []
    if (channels.includes(ChannelType.Public)) results.push(...config.publicChannelIds)
    if (channels.includes(ChannelType.Officer)) results.push(...config.officerChannelIds)

    return results
  }

  async onCommand(event: CommandEvent): Promise<void> {
    await this.sendCommandResponse(event, false)
  }

  async onCommandFeedback(event: CommandFeedbackEvent): Promise<void> {
    await this.sendCommandResponse(event, true)
  }

  private lastInstanceEvent = new Map<InstanceMessageType, number>()

  async onInstanceMessageEvent(event: InstanceMessage): Promise<void> {
    if (
      event.instanceType === this.clientInstance.instanceType &&
      event.instanceName === this.clientInstance.instanceName
    )
      return

    if ((this.lastInstanceEvent.get(event.type) ?? 0) + 5000 > Date.now()) return
    this.lastInstanceEvent.set(event.type, Date.now())

    const replyIds = this.messageAssociation.getMessageId('originEventId' in event ? event.originEventId : undefined)

    for (const replyId of replyIds) {
      try {
        await this.replyWithEmbed(event.eventId, replyId, await this.generateEmbed(event, replyId.guildId))
      } catch (error: unknown) {
        this.logger.error(error, 'can not reply to message. sending the event independently')
        await this.sendEmbedToChannels(event, [replyId.channelId], undefined)
      }
    }
  }

  private removeGuildPrefix(message: string): string {
    const prefixes = ['§2Guild > ', '§3Officer > ', '-'.repeat(53) + '\n']

    let finalMessage = message
    for (const prefix of prefixes) {
      if (finalMessage.startsWith(prefix)) finalMessage = finalMessage.slice(prefix.length)
    }

    return finalMessage
  }

  private async generateEmbed(
    event: BaseInGameEvent<string> | BroadcastEvent | GuildPlayerEvent | MinecraftReactiveEvent | InstanceMessage,
    guildId: string | undefined
  ): Promise<APIEmbed> {
    const embed: APIEmbed = {
      description: escapeMarkdown(event.message),

      footer: { text: beautifyInstanceName(event.instanceName) }
    } satisfies APIEmbed

    if ('color' in event) {
      embed.color = event.color
    }

    if ('user' in event && event.user != undefined) {
      embed.title = event.user.displayName()
      this.assignAvatar(embed, event.user)
    }

    // all enums are unique and must unique for this to work.
    // the other solutions is just too complicated
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    if ('type' in event && event.type === MinecraftReactiveEventType.RequireGuild && guildId !== undefined) {
      // TODO: properly reference client
      // @ts-expect-error client is private variable
      const commands = await this.clientInstance.client.guilds.fetch(guildId).then((guild) => guild.commands.fetch())
      const joinCommand = commands.find((command) => command.name === 'join')
      const setupCommand = commands.find((command) => command.name === 'setup')

      const adminList = this.staticConfig.adminIds.map((adminId) => `<@${adminId}>`)
      embed.description =
        `Looks like the Minecraft account is not in a guild for this to work.\n` +
        `You can ask ${adminList.join(', ')} or any staff who has access\n` +
        `to set it up using </join:${joinCommand?.id}> before using </setup:${setupCommand?.id}> right after.`
    }

    return embed
  }

  private async replyWithEmbed(eventId: string, replyId: DiscordAssociatedMessage, embed: APIEmbed): Promise<void> {
    // TODO: properly reference client
    // @ts-expect-error client is private variable
    const channel = await this.clientInstance.client.channels.fetch(replyId.channelId)
    assert.ok(channel != undefined)
    assert.ok(channel.isSendable())

    const result = await channel.send({
      embeds: [embed],
      reply: { messageReference: replyId.messageId },
      allowedMentions: { parse: [] }
    })
    this.messageAssociation.addMessageId(eventId, {
      guildId: result.guildId ?? undefined,
      channelId: result.channelId,
      messageId: result.id
    })
  }

  private async sendEmbedToChannels(
    event: BaseInGameEvent<string> | BroadcastEvent | CommandEvent | InstanceMessage,
    channels: string[],
    preGeneratedEmbed: APIEmbed | undefined
  ): Promise<Message<true>[]> {
    const messages: Message<true>[] = []

    for (const channelId of channels) {
      try {
        // TODO: properly reference client
        // @ts-expect-error client is private variable
        const channel = await this.clientInstance.client.channels.fetch(channelId)
        if (channel == undefined) continue
        assert.ok(channel.isSendable())
        assert.ok(channel.type === DiscordChannelType.GuildText)

        const embed =
          preGeneratedEmbed ??
          // commands always have a preGenerated embed
          (await this.generateEmbed(event as BaseInGameEvent<string> | BroadcastEvent, channel.guildId))
        const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } })

        messages.push(message)
        this.messageAssociation.addMessageId(event.eventId, {
          guildId: message.inGuild() ? message.guildId : undefined,
          channelId: message.channelId,
          messageId: message.id
        })
      } catch (error: unknown) {
        this.logger.error(`error sending to ${channelId}`, error)
      }
    }

    return messages
  }

  private async sendImageToChannels(eventId: string, channels: string[], image: Buffer): Promise<Message<true>[]> {
    const messages: Message<true>[] = []

    for (const channelId of channels) {
      try {
        // TODO: properly reference client
        // @ts-expect-error client is private variable
        const channel = await this.clientInstance.client.channels.fetch(channelId)
        if (channel == undefined) continue
        assert.ok(channel.isSendable())
        assert.ok(channel.type === DiscordChannelType.GuildText)

        const message = await channel.send({ files: [image] })

        messages.push(message)
        this.messageAssociation.addMessageId(eventId, {
          guildId: message.inGuild() ? message.guildId : undefined,
          channelId: message.channelId,
          messageId: message.id
        })
      } catch (error: unknown) {
        this.logger.error(`error sending to ${channelId}`, error)
      }
    }

    return messages
  }

  private async sendCommandResponse(event: CommandEvent, feedback: boolean): Promise<void> {
    const replyEmbed: APIEmbed = {
      color: Color.Good,
      description: `**${escapeMarkdown(event.commandResponse)}**`,

      title: escapeMarkdown(event.user.displayName()),
      footer: {
        text: feedback ? ' (command feedback)' : ''
      }
    }

    this.assignAvatar(replyEmbed, event.user)

    const replyIds = this.messageAssociation.getMessageId(event.originEventId)
    for (const replyId of replyIds) {
      try {
        if (this.messageToImage.shouldRenderImage()) {
          const message = this.formatRenderedImage(feedback ? 'FEED' : 'COMMAND', event.commandResponse)
          const image = this.messageToImage.generateMessageImage(message)
          await this.sendImageToChannels(event.eventId, [replyId.channelId], image)
        } else {
          await this.replyWithEmbed(event.eventId, replyId, replyEmbed)
        }
      } catch (error: unknown) {
        this.logger.error(error, 'can not reply to message')
      }
    }
  }

  private assignAvatar(embed: APIEmbed, user: User): void {
    const avatar = user.avatar()
    if (avatar !== undefined) embed.thumbnail = { url: avatar }
    const profileLink = user.profileLink()
    if (profileLink !== undefined) embed.url = profileLink
  }

  private webhooks = new Map<string, Webhook>()

  private async getWebhook(channelId: string): Promise<Webhook> {
    const cachedWebhook = this.webhooks.get(channelId)
    if (cachedWebhook !== undefined) return cachedWebhook

    // TODO: properly reference client
    // @ts-expect-error client is private variable
    const channel = (await this.clientInstance.client.channels.fetch(
      channelId
    )) as unknown as TextBasedChannelFields | null
    if (channel == undefined) throw new Error(`no access to channel ${channelId}?`)
    const webhooks = await channel.fetchWebhooks()

    // TODO: properly reference client
    // @ts-expect-error client is private variable
    let webhook = webhooks.find((h) => h.owner?.id === this.clientInstance.client.user?.id)
    webhook ??= await channel.createWebhook({ name: 'Hypixel-Guild-Bridge' })

    this.webhooks.set(channelId, webhook)
    return webhook
  }
}
