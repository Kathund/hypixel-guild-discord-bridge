import type { APIEmbed } from 'discord.js'
import {
  escapeMarkdown,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder
} from 'discord.js'

import { Color, Permission } from '../../../common/application-event.js'
import type { DiscordCommandContext, DiscordCommandHandler } from '../../../common/commands.js'
import { DefaultTimeout, interactivePaging } from '../utility/discord-pager.js'

const IncludeCommand = 'include'
const ExcludeCommand = 'exclude'

const List = 'list'
const Add = 'add'
const Remove = 'remove'

export default {
  getCommandBuilder: () =>
    new SlashCommandBuilder()
      .setName('profanity')
      .setDescription('Manage application profanity filter')
      .addSubcommandGroup(
        new SlashCommandSubcommandGroupBuilder()
          .setName(IncludeCommand)
          .setDescription('Manage filtered words')
          .addSubcommand(
            new SlashCommandSubcommandBuilder().setName(List).setDescription('list all included profanity words')
          )
          .addSubcommand(
            new SlashCommandSubcommandBuilder()
              .setName(Add)
              .setDescription('add profanity words to filter')
              .addStringOption((o) =>
                o.setName('words').setDescription('words to add delimited by a comma').setRequired(true)
              )
          )
          .addSubcommand(
            new SlashCommandSubcommandBuilder()
              .setName(Remove)
              .setDescription('remove profanity words from filter')
              .addStringOption((o) =>
                o.setName('word').setDescription('word to remove').setRequired(true).setAutocomplete(true)
              )
          )
      )
      .addSubcommandGroup(
        new SlashCommandSubcommandGroupBuilder()
          .setName(ExcludeCommand)
          .setDescription('Manage excluded filtered words')
          .addSubcommand(
            new SlashCommandSubcommandBuilder().setName(List).setDescription('list all excluded profanity words')
          )
          .addSubcommand(
            new SlashCommandSubcommandBuilder()
              .setName(Add)
              .setDescription('add an exclusion to profanity filter')
              .addStringOption((o) =>
                o.setName('words').setDescription('words to add delimited by a comma').setRequired(true)
              )
          )
          .addSubcommand(
            new SlashCommandSubcommandBuilder()
              .setName(Remove)
              .setDescription('remove an exclusion from profanity filter')
              .addStringOption((o) =>
                o.setName('word').setDescription('word to remove').setRequired(true).setAutocomplete(true)
              )
          )
      ),
  permission: Permission.Officer,

  handler: async function (context) {
    if (!context.interaction.channel) {
      await context.interaction.reply({
        content: 'This command can only be executed in a text-based guild channel',
        flags: MessageFlags.Ephemeral
      })
      return
    }
    const groupCommand = context.interaction.options.getSubcommandGroup(true)
    switch (groupCommand) {
      case ExcludeCommand:
      case IncludeCommand: {
        await handleProfanityInteraction(context, groupCommand)
        break
      }
    }
  },
  autoComplete: async function (context) {
    const groupCommand = context.interaction.options.getSubcommandGroup(true)
    const subCommand = context.interaction.options.getSubcommand(true)
    if (subCommand === Remove) {
      const option = context.interaction.options.getFocused(true)
      if (option.name !== 'word') return
      const config = context.application.core.getModerationConfig()
      let list: string[] = []
      if (groupCommand === IncludeCommand) {
        list = config.data.profanityBlacklist
      } else if (groupCommand === ExcludeCommand) {
        list = config.data.profanityWhitelist
      } else {
        throw new Error('Unknown list??')
      }

      const response = search(option.value, list)
        .slice(0, 25)
        .map((choice) => ({ name: choice, value: choice }))
      await context.interaction.respond(response)
    }
  }
} satisfies DiscordCommandHandler

export async function handleProfanityInteraction(
  context: DiscordCommandContext,
  group: typeof IncludeCommand | typeof ExcludeCommand
): Promise<void> {
  switch (context.interaction.options.getSubcommand()) {
    case List: {
      await handleList(context, group)
      break
    }
    case Add: {
      await handleAdd(context, group)
      break
    }
    case Remove: {
      await handleRemove(context, group)
      break
    }
  }
}

async function handleList(
  context: DiscordCommandContext,
  group: typeof IncludeCommand | typeof ExcludeCommand
): Promise<void> {
  const EntriesPerPage = 20

  await context.interaction.deferReply()

  await interactivePaging(context.interaction, 0, DefaultTimeout, context.errorHandler, (page) => {
    const config = context.application.core.getModerationConfig()
    let list: string[] | undefined
    if (group === IncludeCommand) {
      list = config.data.profanityBlacklist

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (group === ExcludeCommand) {
      list = config.data.profanityWhitelist
    } else {
      throw new Error('Unknown list??')
    }

    const entries = list.slice(page * EntriesPerPage, page * EntriesPerPage + EntriesPerPage)
    const totalPages = Math.ceil(list.length / EntriesPerPage)
    return {
      totalPages: totalPages,
      embed: {
        title: `[${group}] Profanity Filter (page ${page + 1} out of ${Math.max(totalPages, 1)})`,
        description:
          entries.length === 0 ? '__Empty List__' : entries.map((entry) => `- ${escapeMarkdown(entry)}`).join('\n')
      }
    }
  })
}

async function handleAdd(
  context: DiscordCommandContext,
  group: typeof IncludeCommand | typeof ExcludeCommand
): Promise<void> {
  const config = context.application.core.getModerationConfig()
  let list: string[] | undefined = undefined
  if (group === IncludeCommand) {
    list = config.data.profanityBlacklist

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (group === ExcludeCommand) {
    list = config.data.profanityWhitelist
  } else {
    throw new Error('Unknown list??')
  }

  const words = context.interaction.options
    .getString('words', true)
    .split(',')
    .map((word) => word.trim())

  let changed = false
  const result = { title: "Profanity Filter Add's Results", description: '', color: Color.Good } satisfies APIEmbed

  for (const word of words) {
    if (list.some((entry) => entry.toLowerCase() === word.toLowerCase())) {
      result.description += `- \`${escapeMarkdown(word)}\` already exists.\n`
      result.color = Color.Info
      continue
    }

    list.push(word)
    result.description += `- \`${escapeMarkdown(word)}\` added.\n`
    changed = true
  }

  if (changed) {
    config.markDirty()
    context.application.core.reloadProfanity()
  }
  await context.interaction.reply({ embeds: [result] })
}

async function handleRemove(
  context: DiscordCommandContext,
  group: typeof IncludeCommand | typeof ExcludeCommand
): Promise<void> {
  const config = context.application.core.getModerationConfig()
  let list: string[] | undefined = undefined
  if (group === IncludeCommand) {
    list = config.data.profanityBlacklist

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (group === ExcludeCommand) {
    list = config.data.profanityWhitelist
  } else {
    throw new Error('Unknown list??')
  }

  const word = context.interaction.options.getString('word', true)

  const result = {
    title: `[${group}] Profanity Filter Remove's Result`,
    description: '',
    color: Color.Good
  } satisfies APIEmbed

  const index = list.map((entry) => entry.toLowerCase()).indexOf(word.toLowerCase())
  if (index === -1) {
    result.color = Color.Info
    result.description = `Could not find \`${escapeMarkdown(word)}\` in the list.`
  } else {
    list.splice(index, 1)

    config.markDirty()
    context.application.core.reloadProfanity()

    result.description = `Word \`${escapeMarkdown(word)}\` has been removed from the list.`
  }

  await context.interaction.reply({ embeds: [result] })
}

/**
 * Return a sorted list from best match to least.
 *
 * The results are sorted alphabetically by:
 * - matching the query with the start of a query
 * - matching any part of a username with the query
 *
 * @param query the usernames to look for
 * @param collection collection to look up the query in
 */
function search(query: string, collection: string[]): string[] {
  const copy = [...collection]
  copy.sort((a, b) => a.localeCompare(b))

  const queryLowerCased = query.toLowerCase()
  const results: string[] = []

  for (const username of copy) {
    if (!results.includes(username) && username.toLowerCase().startsWith(queryLowerCased)) {
      results.push(username)
    }
  }

  for (const username of copy) {
    if (!results.includes(username) && username.toLowerCase().includes(queryLowerCased)) {
      results.push(username)
    }
  }

  return results
}
