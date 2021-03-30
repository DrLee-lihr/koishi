import { Context, Channel, App, Argv, User } from 'koishi-core'
import { interpolate, Time } from 'koishi-utils'
import { Meta } from './data'
import { Statistics, Synchronizer } from './stats'
import { SandboxBot } from './adapter'
import { WebServer } from './server'

import './mongo'
import './mysql'

export * from './adapter'
export * from './data'
export * from './stats'
export * from './server'

export type Activity = Record<number, number>

declare module 'koishi-core' {
  interface App {
    webui: WebServer
  }

  interface Database {
    getStats(): Promise<Meta.Stats>
    createSynchronizer(): Synchronizer
  }

  interface Session {
    _sendType?: 'command' | 'dialogue'
  }

  namespace Bot {
    interface Platforms {
      'web': SandboxBot
    }
  }

  interface Bot {
    messageSent: number[]
    messageReceived: number[]
  }

  interface EventMap {
    'status/tick'(): void
  }

  interface User {
    lastCall: Date
    password: string
    token: string
    expire: number
  }

  interface Channel {
    name: string
    activity: Activity
  }
}

Channel.extend(() => ({
  activity: {},
}))

User.extend(() => ({
  expire: 0,
}))

export interface Config extends WebServer.Config, Statistics.Config {
  format?: string
  formatBot?: string
}

const defaultConfig: Config = {
  apiPath: '/status',
  uiPath: '/console',
  selfUrl: '',
  title: 'Koishi 控制台',
  expiration: Time.week,
  tickInterval: Time.second * 5,
  refreshInterval: Time.hour,
  // eslint-disable-next-line no-template-curly-in-string
  formatBot: '{{ username }}：{{ code ? `无法连接` : `工作中（${currentRate[0]}/min）` }}',
  format: [
    '{{ bots }}',
    '==========',
    '活跃用户数量：{{ activeUsers }}',
    '活跃群数量：{{ activeGroups }}',
    'CPU 使用率：{{ (cpu[0] * 100).toFixed() }}% / {{ (cpu[1] * 100).toFixed() }}%',
    '内存使用率：{{ (memory[0] * 100).toFixed() }}% / {{ (memory[1] * 100).toFixed() }}%',
  ].join('\n'),
}

export const name = 'status'

export function apply(ctx: Context, config: Config = {}) {
  config = Object.assign(defaultConfig, config)
  const { apiPath, formatBot, format } = config

  const webui = ctx.app.webui = new WebServer(ctx, config)

  ctx.on('connect', () => webui.start())

  ctx.all().on('command', ({ session }: Argv<'lastCall'>) => {
    session.user.lastCall = new Date()
  })

  ctx.router.get(apiPath, async (koa) => {
    koa.set('Access-Control-Allow-Origin', '*')
    koa.body = await getStatus()
  })

  ctx.command('status', '查看机器人运行状态')
    .shortcut('你的状态', { prefix: true })
    .shortcut('你的状况', { prefix: true })
    .shortcut('运行情况', { prefix: true })
    .shortcut('运行状态', { prefix: true })
    .option('all', '-a  查看全部平台')
    .action(async ({ session, options }) => {
      const status = await getStatus()
      if (!options.all) {
        status.bots = status.bots.filter(bot => bot.platform === session.platform)
      }
      status.bots.toString = () => {
        return status.bots.map(bot => {
          let output = interpolate(formatBot, bot)
          if (options.all) output = `[${bot.platform}] ` + output
          return output
        }).join('\n')
      }
      return interpolate(format, status)
    })

  async function getStatus() {
    const [profile, meta] = await Promise.all([
      webui.sources.profile.get(),
      webui.sources.meta.get(),
    ])
    return { ...profile, ...meta }
  }
}
