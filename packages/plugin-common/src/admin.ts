import { isInteger, difference, observe, Time, enumKeys, Random } from 'koishi-utils'
import { Context, User, Channel, Command, Argv, PlatformType, Session } from 'koishi-core'

type AdminAction<U extends User.Field, G extends Channel.Field, A extends any[], O extends {}, T>
  = (argv: Argv<U | 'authority', G, A, O> & { target: T }, ...args: A)
    => void | string | Promise<void | string>

declare module 'koishi-core/dist/command' {
  interface Command<U, G, A, O> {
    adminUser(callback: AdminAction<U, G, A, O, User.Observed<U | 'authority'>>): this
    adminChannel(callback: AdminAction<U, G, A, O, Channel.Observed<G>>): this
  }
}

interface FlagOptions {
  list?: boolean
  set?: boolean
  unset?: boolean
}

type FlagMap = Record<string, number> & Record<number, string>

interface FlagArgv extends Argv<never, never, string[], FlagOptions> {
  target: User.Observed<'flag'> | Channel.Observed<'flag'>
}

function flagAction(map: any, { target, options }: FlagArgv, ...flags: string[]): string
function flagAction(map: FlagMap, { target, options }: FlagArgv, ...flags: string[]) {
  if (options.set || options.unset) {
    const notFound = difference(flags, enumKeys(map))
    if (notFound.length) return `未找到标记 ${notFound.join(', ')}。`
    for (const name of flags) {
      options.set ? target.flag |= map[name] : target.flag &= ~map[name]
    }
    return
  }

  if (options.list) {
    return `全部标记为：${enumKeys(map).join(', ')}。`
  }

  let flag = target.flag
  const keys: string[] = []
  while (flag) {
    const value = 2 ** Math.floor(Math.log2(flag))
    flag -= value
    keys.unshift(map[value])
  }
  if (!keys.length) return '未设置任何标记。'
  return `当前的标记为：${keys.join(', ')}。`
}

Command.prototype.adminUser = function (this: Command, callback) {
  const command = this
    .userFields(['authority'])
    .option('target', '-t [user]  指定目标用户', { authority: 3 })

  command._actions.unshift(async (argv) => {
    const { options, session, args } = argv
    const fields = session.collect('user', argv)
    let target: User.Observed<never>
    if (options.target) {
      const id = session.$bot.parseUser(options.target)
      if (!id) return '请指定正确的目标。'
      const { database } = session.$app
      const data = await database.getUser(session.platform, '' + id, [...fields])
      if (!data) return '未找到指定的用户。'
      if (id === session.userId) {
        target = await session.observeUser(fields)
      } else if (session.$user.authority <= data.authority) {
        return '权限不足。'
      } else {
        target = observe(data, diff => database.setUser(session.platform, '' + id, diff), `user ${id}`)
      }
    } else {
      target = await session.observeUser(fields)
    }
    const diffKeys = Object.keys(target._diff)
    const result = await callback({ ...argv, target }, ...args)
    if (typeof result === 'string') return result
    if (!difference(Object.keys(target._diff), diffKeys).length) return '用户数据未改动。'
    await target._update()
    return '用户数据已修改。'
  })

  return command
}

Command.prototype.adminChannel = function (this: Command, callback) {
  const command = this
    .userFields(['authority'])
    .option('target', '-t [channel]  指定目标频道', { authority: 3 })

  command._actions.unshift(async (argv, ...args) => {
    const { options, session } = argv
    const fields = session.collect('channel', argv)
    let target: Channel.Observed
    if (options.target) {
      const id = session.$bot.parseChannel(options.target)
      if (!id) return '请指定正确的目标。'
      const { database } = session.$app
      const data = await session.getChannel(id, '', [...fields])
      if (!data) return '未找到指定的频道。'
      target = observe(data, diff => database.setChannel(session.platform, id, diff), `channel ${id}`)
    } else if (session.subtype === 'group') {
      target = await session.observeChannel(fields)
    } else {
      return '当前不在群组上下文中，请使用 -t 参数指定目标频道。'
    }
    const result = await callback({ ...argv, target }, ...args)
    if (typeof result === 'string') return result
    if (!Object.keys(target._diff).length) return '频道数据未改动。'
    await target._update()
    return '频道数据已修改。'
  })

  return command
}

export interface AdminConfig {
  checkName?: (name: string, session: Session) => string
}

export function apply(ctx: Context, options: AdminConfig = {}) {
  ctx.command('common/user', '用户管理', { authority: 3 })
  ctx.command('common/channel', '频道管理', { authority: 3 })

  ctx.command('common/callme <name:text>', '修改自己的称呼')
    .userFields(['id', 'name'])
    .shortcut('叫我', { prefix: true, fuzzy: true, greedy: true })
    .action(async ({ session }, name) => {
      if (!name) {
        return `好的，${session.$username}，请多指教！`
      } else if (name === session.$user.name) {
        return '称呼未发生变化。'
      } else if (/^\s+$/.test(name)) {
        return '称呼不能为空。'
      }

      const result = options.checkName(name, session)
      if (result) return result

      try {
        session.$user.name = name
        await session.$user._update()
        return `好的，${session.$username}，请多指教！`
      } catch (error) {
        if (error[Symbol.for('koishi.error-type')] === 'duplicate-entry') {
          return '禁止与其他用户重名。'
        } else {
          ctx.logger('common').warn(error)
          return '修改称呼失败。'
        }
      }
    })

  const tokens: Record<string, [platform: PlatformType, id: string]> = {}

  ctx.unselect('groupId').command('user.bind', '绑定到账号', { authority: 0 })
    .action(({ session }) => {
      const token = Random.uuid()
      const data = tokens[token] = [session.platform, session.userId]
      setTimeout(() => {
        if (tokens[token] === data) delete tokens[token]
      }, 5 * Time.minute)
      return [
        '请在 5 分钟内使用你的账号在已绑定的平台内向四季酱私聊发送以下文本：',
        token,
        '注意：每个账号只能绑定到每个平台一次，此操作将会抹去你当前平台上的数据，请谨慎操作！',
      ].join('\n')
    })

  ctx.middleware(async (session, next) => {
    if (session.subtype !== 'private') return next()
    const data = tokens[session.content]
    if (!data) return next()
    const user = await session.observeUser(['authority', data[0]])
    if (!user.authority) return next()
    if (user[data[0]]) return session.send('账号绑定失败：你已经绑定过该平台。')
    user[data[0]] = data[1]
    await user._update()
    return session.send('账号绑定成功！')
  }, true)

  ctx.command('user.auth <value>', '权限信息', { authority: 4 })
    .adminUser(({ session, target }, value) => {
      const authority = Number(value)
      if (!isInteger(authority) || authority < 0) return '参数错误。'
      if (authority >= session.$user.authority) return '权限不足。'
      target.authority = authority
    })

  ctx.command('user.flag [-s|-S] [...flags]', '标记信息', { authority: 3 })
    .userFields(['flag'])
    .option('list', '-l  标记列表')
    .option('set', '-s  添加标记', { authority: 4 })
    .option('unset', '-S  删除标记', { authority: 4 })
    .adminUser(flagAction.bind(null, User.Flag))

  ctx.command('user.usage [key]', '调用次数信息')
    .userFields(['usage'])
    .option('set', '-s  设置调用次数', { authority: 4 })
    .option('clear', '-c  清空调用次数', { authority: 4 })
    .adminUser(({ target, options }, name, value) => {
      if (options.clear) {
        name ? delete target.usage[name] : target.usage = {}
        return
      }

      if (options.set) {
        if (value === undefined) return '参数不足。'
        const count = +value
        if (!isInteger(count) || count < 0) return '参数错误。'
        target.usage[name] = count
        return
      }

      if (name) return `今日 ${name} 功能的调用次数为：${target.usage[name] || 0}`
      const output: string[] = []
      for (const name of Object.keys(target.usage).sort()) {
        if (name.startsWith('$')) continue
        output.push(`${name}：${target.usage[name]}`)
      }
      if (!output.length) return '今日没有调用过消耗次数的功能。'
      output.unshift('今日各功能的调用次数为：')
      return output.join('\n')
    })

  ctx.command('user.timer [key]', '定时器信息')
    .userFields(['timers'])
    .option('set', '-s  设置定时器', { authority: 4 })
    .option('clear', '-c  清空定时器', { authority: 4 })
    .adminUser(({ target, options }, name, value) => {
      if (options.clear) {
        name ? delete target.timers[name] : target.timers = {}
        return
      }

      if (options.set) {
        if (value === undefined) return '参数不足。'
        const timestamp = +Time.parseDate(value)
        if (!timestamp) return '请输入合法的时间。'
        target.timers[name] = timestamp
        return
      }

      const now = Date.now()
      if (name) {
        const delta = target.timers[name] - now
        if (delta > 0) return `定时器 ${name} 的生效时间为：剩余 ${Time.formatTime(delta)}`
        return `定时器 ${name} 当前并未生效。`
      }
      const output: string[] = []
      for (const name of Object.keys(target.timers).sort()) {
        if (name.startsWith('$')) continue
        output.push(`${name}：剩余 ${Time.formatTime(target.timers[name] - now)}`)
      }
      if (!output.length) return '当前没有生效的定时器。'
      output.unshift('各定时器的生效时间为：')
      return output.join('\n')
    })

  ctx.command('channel.assign [bot]', '受理者账号', { authority: 4 })
    .channelFields(['assignee'])
    .adminChannel(({ session, target }, value) => {
      const assignee = value ? session.$bot.parseUser(value) : session.selfId
      if (!assignee) return '参数错误。'
      target.assignee = assignee
    })

  ctx.command('channel.flag [-s|-S] [...flags]', '标记信息', { authority: 3 })
    .channelFields(['flag'])
    .option('list', '-l  标记列表')
    .option('set', '-s  添加标记', { authority: 4 })
    .option('unset', '-S  删除标记', { authority: 4 })
    .adminChannel(flagAction.bind(null, Channel.Flag))
}
