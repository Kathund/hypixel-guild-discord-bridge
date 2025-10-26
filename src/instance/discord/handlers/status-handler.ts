import type { Client } from 'discord.js'
import { ActivityType } from 'discord.js'

import type { InstanceType } from '../../../common/application-event.js'
import SubInstance from '../../../common/sub-instance'
import type DiscordInstance from '../discord-instance.js'

export default class StatusHandler extends SubInstance<DiscordInstance, InstanceType.Discord, Client> {
  override registerEvents(client: Client): void {
    client.on('clientReady', (client) => {
      client.user.setPresence({
        status: 'online',
        activities: [{ name: 'Connecting Hypixel guilds with Discord!', type: ActivityType.Custom }]
      })
    })
  }
}
