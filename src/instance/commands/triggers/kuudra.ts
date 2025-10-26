import type { ChatCommandContext } from '../../../common/commands.js'
import { ChatCommandHandler } from '../../../common/commands.js'
import {
  getSelectedSkyblockProfile,
  getUuidIfExists,
  playerNeverEnteredCrimson,
  playerNeverPlayedSkyblock,
  usernameNotExists
} from '../common/utility'

export default class Kuudra extends ChatCommandHandler {
  constructor() {
    super({
      triggers: ['kuudra', 'k'],
      description: "Returns a player's kuudra runs",
      example: `kuudra %s`
    })
  }

  async handler(context: ChatCommandContext): Promise<string> {
    const givenUsername = context.args[0] ?? context.username

    const uuid = await getUuidIfExists(context.app.mojangApi, givenUsername)
    if (uuid == undefined) return usernameNotExists(givenUsername)

    const selectedProfile = await getSelectedSkyblockProfile(context.app.hypixelApi, uuid)
    if (!selectedProfile) return playerNeverPlayedSkyblock(givenUsername)

    if (!selectedProfile.nether_island_player_data) return playerNeverEnteredCrimson(givenUsername)
    const tiers = selectedProfile.nether_island_player_data.kuudra_completed_tiers

    const completions = Object.entries(tiers)
      .filter(([key]) => !key.startsWith('highest_wave'))
      .map(([, value]) => value)
    return `${givenUsername}: ${completions.join('/')}`
  }
}
