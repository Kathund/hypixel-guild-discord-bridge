import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js'
import { Collection, escapeMarkdown, MessageFlags, REST, Routes } from 'discord.js'
import type { Logger } from 'log4js'

import type Application from '../../application.js'
import { ChannelType, Color, InstanceType, Permission } from '../../common/application-event.js'
import type { DiscordAutoCompleteContext, DiscordCommandContext, DiscordCommandHandler } from '../../common/commands.js'
import { CommandScope, OptionToAddMinecraftInstances } from '../../common/commands.js'
import type { ConfigManager } from '../../common/config-manager.js'
import type EventHelper from '../../common/event-helper.js'
import SubInstance from '../../common/sub-instance'
import type UnexpectedErrorHandler from '../../common/unexpected-error-handler.js'

import AboutCommand from './commands/about.js'
import AcceptCommand from './commands/accept.js'
import ConnectivityCommand from './commands/connectivity.js'
import CreateLeaderboardCommand from './commands/create-leaderboard.js'
import DemoteCommand from './commands/demote.js'
import DisconnectCommand from './commands/disconnect.js'
import ExecuteCommand from './commands/execute.js'
import HelpCommand from './commands/help.js'
import InviteCommand from './commands/invite.js'
import JoinCommand from './commands/join.js'
import LeaderboardCommand from './commands/leaderboard.js'
import LinkCommand from './commands/link.js'
import ListLeaderboardCommand from './commands/list-leaderboard'
import ListCommand from './commands/list.js'
import LogCommand from './commands/log.js'
import PingCommand from './commands/ping.js'
import ProfanityCommand from './commands/profanity.js'
import PromoteCommand from './commands/promote.js'
import PunishmentsCommand from './commands/punishments.js'
import ReconnectCommand from './commands/reconnect.js'
import RestartCommand from './commands/restart.js'
import SetrankCommand from './commands/setrank.js'
import SettingsCommand from './commands/settings.js'
import UnlinkCommand from './commands/unlink.js'
import VerificationCommand from './commands/verification.js'
import type { DiscordConfig } from './common/discord-config.js'
import { DefaultCommandFooter } from './common/discord-config.js'
import type DiscordInstance from './discord-instance.js'

export class CommandManager extends SubInstance<DiscordInstance, InstanceType.Discord, Client> {
  readonly commands = new Collection<string, DiscordCommandHandler>()
  private readonly config: ConfigManager<DiscordConfig>

  constructor(
    application: Application,
    clientInstance: DiscordInstance,
    config: ConfigManager<DiscordConfig>,
    eventHelper: EventHelper<InstanceType.Discord>,
    logger: Logger,
    errorHandler: UnexpectedErrorHandler
  ) {
    super(application, clientInstance, eventHelper, logger, errorHandler)
    this.config = config
    this.addDefaultCommands()
  }

  override registerEvents(client: Client): void {
    let listenerStarted = false
    client.on('clientReady', (client) => {
      if (listenerStarted) return
      listenerStarted = true
      this.listenToRegisterCommands(client)
    })

    client.on('interactionCreate', (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.onCommand(interaction).catch(
          this.errorHandler.promiseCatch('handling incoming ChatInputCommand event')
        )
      } else if (interaction.isAutocomplete()) {
        void this.onAutoComplete(interaction).catch(
          this.errorHandler.promiseCatch('handling incoming autocomplete event')
        )
      }
    })
    this.logger.debug('CommandManager is registered')
  }

  private listenToRegisterCommands(client: Client<true>): void {
    const timeoutId = setTimeout(() => {
      this.registerDiscordCommand(client)
    }, 5 * 1000)

    this.application.on('minecraftSelfBroadcast', (): void => {
      timeoutId.refresh()
    })
    this.application.on('instanceAnnouncement', (event): void => {
      if (event.instanceType === InstanceType.Minecraft) {
        timeoutId.refresh()
      }
    })
  }

  private addDefaultCommands(): void {
    const toAdd = [
      AboutCommand,
      AcceptCommand,
      SettingsCommand,
      ConnectivityCommand,
      CreateLeaderboardCommand,
      DemoteCommand,
      DisconnectCommand,
      HelpCommand,
      InviteCommand,
      JoinCommand,
      LeaderboardCommand,
      LinkCommand,
      ListCommand,
      ListLeaderboardCommand,
      LogCommand,
      ExecuteCommand,
      PingCommand,
      ProfanityCommand,
      PromoteCommand,
      PunishmentsCommand,
      ReconnectCommand,
      SetrankCommand,
      RestartCommand,
      UnlinkCommand,
      VerificationCommand
    ]

    for (const command of toAdd) {
      this.commands.set(command.getCommandBuilder().name, command)
    }
  }

  private async onAutoComplete(interaction: AutocompleteInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName)
    if (!command) {
      this.logger.warn(`command ${interaction.commandName} not found for autocomplete interaction.`)
      return
    }

    const identifier = this.clientInstance.profileByUser(
      interaction.user,
      interaction.inCachedGuild() ? interaction.member : undefined
    )
    const user = await this.application.core.initializeDiscordUser(identifier, {
      guild: interaction.guild ?? undefined
    })
    const permission = user.permission()
    if (command.autoComplete) {
      const context: DiscordAutoCompleteContext = {
        application: this.application,
        eventHelper: this.eventHelper,
        logger: this.logger,
        errorHandler: this.errorHandler,
        instanceName: this.clientInstance.instanceName,
        user: user,
        permission: permission,
        interaction: interaction,
        allCommands: [...this.commands.values()]
      }

      try {
        await command.autoComplete(context)
      } catch (error: unknown) {
        this.logger.error(error)
      }
    }
  }

  /*
   * - allow when channel registered and permitted
   * - allow if channel not registered but command requires admin and user is permitted
   * - disallow if not permitted
   * - disallow if not in proper channel
   */
  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    this.logger.debug(`${interaction.user.tag} executing ${interaction.commandName}`)
    const command = this.commands.get(interaction.commandName)

    try {
      const channelType = this.getChannelType(interaction.channelId)
      const identifier = this.clientInstance.profileByUser(
        interaction.user,
        interaction.inCachedGuild() ? interaction.member : undefined
      )
      const user = await this.application.core.initializeDiscordUser(identifier, {
        guild: interaction.guild ?? undefined
      })
      const permission = user.permission()

      if (command == undefined) {
        this.logger.debug(`command but it doesn't exist: ${interaction.commandName}`)

        await interaction.reply({
          content: 'Command is not implemented somehow. Maybe there is new a version?',
          flags: MessageFlags.Ephemeral
        })
        return
      }

      if (permission < (command.permission ?? Permission.Anyone)) {
        this.logger.debug('No permission to execute this command')

        await interaction.reply({
          content: "You don't have permission to execute this command",
          flags: MessageFlags.Ephemeral
        })
        return
      }

      const scopeCheck = this.checkScope(command.scope ?? CommandScope.Anywhere, channelType)
      if (scopeCheck !== undefined) {
        this.logger.debug(`can't execute in channel ${interaction.channelId}`)
        await interaction.reply({ content: scopeCheck, flags: MessageFlags.Ephemeral })
        return
      }

      if (
        (command.addMinecraftInstancesToOptions === OptionToAddMinecraftInstances.Required ||
          command.addMinecraftInstancesToOptions === OptionToAddMinecraftInstances.Optional) &&
        this.application.getInstancesNames(InstanceType.Minecraft).length === 0
      ) {
        await interaction.reply({
          embeds: [
            {
              title: `Command ${escapeMarkdown(command.getCommandBuilder().name)}`,
              description:
                `No Minecraft instance exist.\n` +
                'This is a Minecraft command that requires a working Minecraft account connected to the bridge.\n' +
                `Check the tutorial on how to add a Minecraft account before using this command.`,
              color: Color.Info,
              footer: {
                text: DefaultCommandFooter
              }
            }
          ],
          flags: MessageFlags.Ephemeral
        })
        return
      }

      this.logger.debug('execution granted.')

      const commandContext: DiscordCommandContext = {
        application: this.application,
        eventHelper: this.eventHelper,
        logger: this.logger,
        errorHandler: this.errorHandler,
        instanceName: this.clientInstance.instanceName,
        user: user,
        permission: permission,
        interaction: interaction,
        allCommands: [...this.commands.values()],

        showPermissionDenied: async () => {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: "You don't have permission to execute this command"
            })
            return
          } else {
            await interaction.reply({
              content: "You don't have permission to execute this command",
              flags: MessageFlags.Ephemeral
            })
            return
          }
        }
      }

      await command.handler(commandContext)
      return
    } catch (error) {
      this.logger.error(error)

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'There was an error while executing command'
        })
        return
      } else {
        await interaction.reply({
          content: 'There was an error while executing command',
          flags: MessageFlags.Ephemeral
        })
        return
      }
    }
  }

  private checkScope(scope: CommandScope, channelType: ChannelType | undefined): string | undefined {
    switch (scope) {
      case CommandScope.Chat: {
        if (channelType === ChannelType.Public || channelType === ChannelType.Officer) return undefined
        return 'You can only use commands in public/officer bridge channels!'
      }
      case CommandScope.Privileged: {
        if (channelType === ChannelType.Officer) return undefined
        return 'You can only use commands in officer bridge channels!'
      }
      case CommandScope.Anywhere: {
        return undefined
      }
      default: {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unknown scope: ${scope}`)
      }
    }
  }

  private registerDiscordCommand(client: Client<true>): void {
    this.logger.debug('Registering commands')

    const token = client.token
    const clientId = client.application.id
    const commandsJson = this.getCommandsJson()

    for (const [, guild] of client.guilds.cache) {
      this.logger.debug(`Informing guild ${guild.id} about commands`)
      const rest = new REST().setToken(token)
      void rest
        .put(Routes.applicationGuildCommands(clientId, guild.id), { body: commandsJson })
        .catch(this.errorHandler.promiseCatch('registering discord commands'))
    }
  }

  private getChannelType(channelId: string): ChannelType | undefined {
    const config = this.config.data
    if (config.publicChannelIds.includes(channelId)) return ChannelType.Public
    if (config.officerChannelIds.includes(channelId)) return ChannelType.Officer
    return undefined
  }

  private getCommandsJson(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    const commandsJson: RESTPostAPIChatInputApplicationCommandsJSONBody[] = []
    const instanceChoices = this.application
      .getInstancesNames(InstanceType.Minecraft)
      .map((choice: string) => ({ name: choice, value: choice }))

    /*
    options are added after converting to json.
    This is done to specifically insert the "instance" option directly after the required options
    the official api doesn't support this. So JSON manipulation is used instead.
    This is mainly used for "Required" option.
    Discord will throw an error with "invalid body" otherwise.
     */
    for (const command of this.commands.values()) {
      const commandBuilder = command.getCommandBuilder().toJSON()
      const instanceCommandName = 'instance'
      const instanceCommandDescription = 'Which instance to send this command to'

      if (instanceChoices.length > 0) {
        const index = commandBuilder.options?.findIndex((option) => option.required) ?? -1

        switch (command.addMinecraftInstancesToOptions) {
          case OptionToAddMinecraftInstances.Required: {
            commandBuilder.options ??= []

            // splice is just fancy push at certain index
            commandBuilder.options.splice(index + 1, 0, {
              type: 3,
              name: instanceCommandName,
              description: instanceCommandDescription,
              choices: instanceChoices,
              required: true
            })
            break
          }
          case OptionToAddMinecraftInstances.Optional: {
            commandBuilder.options ??= []
            commandBuilder.options.push({
              type: 3,
              name: instanceCommandName,
              description: instanceCommandDescription,
              choices: instanceChoices
            })
          }
        }
      }

      commandsJson.push(commandBuilder)
    }

    return commandsJson
  }
}
