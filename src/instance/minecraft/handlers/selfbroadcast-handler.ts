import type { InstanceType } from '../../../common/application-event.js'
import SubInstance from '../../../common/sub-instance'
import type ClientSession from '../client-session.js'
import type MinecraftInstance from '../minecraft-instance.js'

export default class SelfbroadcastHandler extends SubInstance<
  MinecraftInstance,
  InstanceType.Minecraft,
  ClientSession
> {
  override registerEvents(clientSession: ClientSession): void {
    // first spawn packet
    clientSession.client.on('login', () => {
      this.onSpawn()
    })
    // change world packet
    clientSession.client.on('respawn', () => {
      this.onSpawn()
    })
  }

  private onSpawn(): void {
    const username = this.clientInstance.username()
    const uuid = this.clientInstance.uuid()

    if (username != undefined && uuid != undefined) {
      this.application.emit('minecraftSelfBroadcast', {
        ...this.eventHelper.fillBaseEvent(),

        uuid,
        username
      })
    }
  }
}
