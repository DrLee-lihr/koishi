/* eslint-disable camelcase */

import axios, { Method } from 'axios'
import { Bot, MessageInfo } from 'koishi-core'
import * as DC from './types'
import { adaptChannel, adaptGroup, adaptMessage, adaptUser } from './utils'
import { readFileSync } from 'fs'
import { segment } from 'koishi-utils'
import FormData from 'form-data'
import FileType from 'file-type'

export type HandleExternalAssets = 'auto' | 'download' | 'direct'

export class SenderError extends Error {
  constructor(url: string, data: any, selfId: string) {
    super(`Error when trying to request ${url}, data: ${JSON.stringify(data)}`)
    Object.defineProperties(this, {
      name: { value: 'SenderError' },
      selfId: { value: selfId },
      data: { value: data },
      url: { value: url },
    })
  }
}

export class DiscordBot extends Bot<'discord'> {
  _d = 0
  version = 'discord'
  _ping: NodeJS.Timeout
  _sessionId: string = ''

  async request<T = any>(method: Method, path: string, data?: any, exHeaders?: any): Promise<T> {
    const { axiosConfig, discord = {} } = this.app.options
    const endpoint = discord.endpoint || 'https://discord.com/api/v8'
    const url = `${endpoint}${path}`
    try {
      const response = await axios({
        ...axiosConfig,
        ...discord.axiosConfig,
        method,
        url,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...exHeaders,
        },
        data,
      })
      return response.data
    } catch (e) {
      throw new SenderError(url, data, this.selfId)
    }
  }

  async getSelf() {
    const data = await this.request<DC.DiscordUser>('GET', '/users/@me')
    return adaptUser(data)
  }

  private async sendEmbed(requestUrl: string, fileBuffer: Buffer, payload_json: Record<string, any> = {}) {
    const fd = new FormData()
    const type = await FileType.fromBuffer(fileBuffer)
    fd.append('file', fileBuffer, 'file.' + type.ext)
    fd.append('payload_json', JSON.stringify(payload_json))
    const r = await this.request('POST', requestUrl, fd, fd.getHeaders())
    return r.id as string
  }

  private async sendContent(requestUrl: string, content: string, addition: Record<string, any>) {
    const r = await this.request('POST', requestUrl, {
      ...addition,
      content,
    })
    return r.id as string
  }

  private parseQuote(chain: segment.Chain) {
    if (chain[0].type !== 'quote') return
    return chain.shift().data.id
  }

  async sendPrivateMessage(channelId: string, content: string) {
    return this.sendMessage(channelId, content)
  }

  private async sendEmbedAsset(requestUrl: string, type: string, data: Record<string, string>, addition: Record<string, any>) {
    if (!data.url) throw new Error('invalid segment: url expected')
    if (data.url.startsWith('file://')) {
      return this.sendEmbed(requestUrl, readFileSync(data.url.slice(8)), addition)
    } else if (data.url.startsWith('base64://')) {
      const a = Buffer.from(data.url.slice(9), 'base64')
      return await this.sendEmbed(requestUrl, a, addition)
    }

    const { axiosConfig, discord = {} } = this.app.options
    const sendMode =
      data.mode as HandleExternalAssets || // define in segment
      discord.handleExternalAssets || // define in app options
      'auto' // default

    const sendDownload = async () => {
      const a = await axios.get(data.url, {
        ...axiosConfig,
        ...discord.axiosConfig,
        responseType: 'arraybuffer',
        headers: {
          accept: type + '/*',
        },
      })
      return this.sendEmbed(requestUrl, a.data, addition)
    }

    if (sendMode === 'direct') {
      // send url directly
      return this.sendContent(requestUrl, data.url, addition)
    } else if (sendMode === 'download') {
      // download send
      return sendDownload()
    }

    // auto mode
    await axios.head(data.url, {
      ...axiosConfig,
      ...discord.axiosConfig,
      headers: {
        accept: type + '/*',
      },
    }).then(({ headers }) => {
      if (headers['content-type'].includes(type)) {
        return this.sendContent(requestUrl, data.url, addition)
      } else {
        return sendDownload()
      }
    }, sendDownload)
  }

  private async sendFullMessage(requestUrl: string, content: string, addition: Record<string, any> = {}): Promise<string> {
    const chain = segment.parse(content)
    let sentMessageId = '0'
    let needSend = ''
    const isWebhook = requestUrl.startsWith('/webhooks/')
    delete addition.content

    const sendBuffer = async () => {
      const content = needSend.trim()
      if (!content) return
      sentMessageId = await this.sendContent(requestUrl, content, addition)
      needSend = ''
    }

    for (const code of chain) {
      const { type, data } = code
      if (type === 'text') {
        needSend += data.content.trim()
      } else if (type === 'at' && data.id) {
        needSend += `<@${data.id}>`
      } else if (type === 'at' && data.type === 'all') {
        needSend += `@everyone`
      } else if (type === 'at' && data.type === 'here') {
        needSend += `@here`
      } else if (type === 'sharp' && data.id) {
        needSend += `<#${data.id}>`
      } else if (type === 'face' && data.name && data.id) {
        needSend += `<:${data.name}:${data.id}>`
      } else {
        await sendBuffer()
        if (type === 'image' || type === 'video') {
          sentMessageId = await this.sendEmbedAsset(requestUrl, type, data, addition)
        } else if (type === 'share') {
          const sendData = isWebhook ? {
            embeds: [{ ...addition, ...data }],
          } : {
            embed: { ...addition, ...data },
          }
          const r = await this.request('POST', requestUrl, {
            ...sendData,
          })
          sentMessageId = r.id
        }
      }
    }

    await sendBuffer()
    return sentMessageId
  }

  async sendMessage(channelId: string, content: string, groupId?: string) {
    const session = this.createSession({ channelId, content, groupId, subtype: groupId ? 'group' : 'private' })
    if (await this.app.serial(session, 'before-send', session)) return

    const chain = segment.parse(session.content)
    const quote = this.parseQuote(chain)
    const message_reference = quote ? {
      message_id: quote,
    } : undefined

    session.messageId = await this.sendFullMessage(`/channels/${channelId}/messages`, session.content, { message_reference })

    this.app.emit(session, 'send', session)
    return session.messageId
  }

  deleteMessage(channelId: string, messageId: string) {
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}`)
  }

  async editMessage(channelId: string, messageId: string, content: string) {
    const chain = segment.parse(content)
    const image = chain.find(v => v.type === 'image')
    if (image) {
      throw new Error("You can't include embed object(s) while editing message.")
    }
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      content,
    })
  }

  $getMessage(channelId: string, messageId: string) {
    return this.request<DC.Message>('GET', `/channels/${channelId}/messages/${messageId}`)
  }

  async getMessage(channelId: string, messageId: string): Promise<MessageInfo> {
    const [msg, channel] = await Promise.all([
      this.$getMessage(channelId, messageId),
      this.$getChannel(channelId),
    ])
    const result: MessageInfo = {
      messageId: msg.id,
      channelId: msg.channel_id,
      groupId: channel.guild_id,
      userId: msg.author.id,
      content: msg.content,
      timestamp: new Date(msg.timestamp).valueOf(),
      author: adaptUser(msg.author),
    }
    result.author.nickname = msg.member?.nick
    if (msg.message_reference) {
      const quoteMsg = await this.$getMessage(msg.message_reference.channel_id, msg.message_reference.message_id)
      result.quote = await adaptMessage(this, quoteMsg)
    }
    return result
  }

  async getUser(userId: string) {
    const data = await this.request<DC.DiscordUser>('GET', `/users/${userId}`)
    return adaptUser(data)
  }

  async getGroupMemberList(guildId: string) {
    const data = await this.$listGuildMembers(guildId)
    return data.map(v => adaptUser(v.user))
  }

  async getChannel(channelId: string) {
    const data = await this.$getChannel(channelId)
    return adaptChannel(data)
  }

  async $executeWebhook(id: string, token: string, data: DC.ExecuteWebhookBody, wait = false): Promise<string> {
    const chain = segment.parse(data.content)
    if (chain.filter(v => v.type === 'image').length > 10) {
      throw new Error('Up to 10 embed objects')
    }

    return await this.sendFullMessage(`/webhooks/${id}/${token}?wait=${wait}`, data.content, data)
  }

  $getGuildMember(guildId: string, userId: string) {
    return this.request<DC.GuildMember>('GET', `/guilds/${guildId}/members/${userId}`)
  }

  async getGroupMember(groupId: string, userId: string) {
    const member = await this.$getGuildMember(groupId, userId)
    return {
      ...adaptUser(member.user),
      nickname: member.nick,
    }
  }

  $getGuildRoles(guildId: string) {
    return this.request<DC.Role[]>('GET', `/guilds/${guildId}/roles`)
  }

  $getChannel(channelId: string) {
    return this.request<DC.Channel>('GET', `/channels/${channelId}`)
  }

  $listGuildMembers(guildId: string, limit?: number, after?: string) {
    return this.request<DC.GuildMember[]>('GET', `/guilds/${guildId}/members?limit=${limit || 1000}&after=${after || '0'}`)
  }

  async $getRoleMembers(guildId: string, roleId: string) {
    let members: DC.GuildMember[] = []
    let after = '0'
    while (true) {
      const data = await this.$listGuildMembers(guildId, 1000, after)
      members = members.concat(data)
      if (data.length) {
        after = data[data.length - 1].user.id
      } else {
        break
      }
    }
    return members.filter(v => v.roles.includes(roleId))
  }

  $modifyGuildMember(guildId: string, userId: string, data: Partial<DC.ModifyGuildMember>) {
    return this.request('PATCH', `/guilds/${guildId}/members/${userId}`, data)
  }

  $setGroupCard(guildId: string, userId: string, nick: string) {
    return this.$modifyGuildMember(guildId, userId, { nick })
  }

  $addGuildMemberRole(guildId: string, userId: string, roleId: string) {
    return this.request('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`)
  }

  $removeGuildMemberRole(guildId: string, userId: string, roleId: string) {
    return this.request('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`)
  }

  $createGuildRole(guildId: string, data: DC.GuildRoleBody) {
    return this.request('POST', `/guilds/${guildId}/roles`, data)
  }

  $modifyGuildRole(guildId: string, roleId: string, data: Partial<DC.GuildRoleBody>) {
    return this.request('PATCH', `/guilds/${guildId}/roles/${roleId}`, data)
  }

  $modifyGuild(guildId: string, data: DC.GuildModify) {
    return this.request('PATCH', `/guilds/${guildId}`, data)
  }

  $setGroupName(guildId: string, name: string) {
    return this.$modifyGuild(guildId, { name })
  }

  $createWebhook(channelId: string, data: {
    name: string;
    avatar?: string
  }) {
    return this.request('POST', `/channels/${channelId}/webhooks`, data)
  }

  $modifyWebhook(webhookId: string, data: {
    name?: string;
    avatar?: string
    channel_id?: string
  }) {
    return this.request('PATCH', `/webhooks/${webhookId}`, data)
  }

  $getChannelWebhooks(channelId: string) {
    return this.request<DC.Webhook[]>('GET', `/channels/${channelId}/webhooks`)
  }

  $getGuildWebhooks(guildId: string) {
    return this.request<DC.Webhook[]>('GET', `/guilds/${guildId}/webhooks`)
  }

  $modifyChannel(channelId: string, data: DC.ModifyChannel) {
    return this.request('PATCH', `/channels/${channelId}`, data)
  }

  $getGuild(guildId: string) {
    return this.request<DC.Guild>('GET', `/guilds/${guildId}`)
  }

  async getGroup(groupId: string) {
    const data = await this.$getGuild(groupId)
    return adaptGroup(data)
  }

  async $getUserGuilds() {
    return this.request<DC.PartialGuild[]>('GET', '/users/@me/guilds')
  }

  async getGroupList() {
    const data = await this.$getUserGuilds()
    return data.map(v => adaptGroup(v))
  }

  $getGuildChannels(guildId: string) {
    return this.request<DC.Channel[]>('GET', `/guilds/${guildId}/channels`)
  }

  async getChannelList(groupId: string) {
    const data = await this.$getGuildChannels(groupId)
    return data.map(v => adaptChannel(v))
  }
}
