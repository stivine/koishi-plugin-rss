import { Context, Session, Logger, Time, Schema } from 'koishi'
import RssFeedEmitter from 'rss-feed-emitter'
import axios from 'axios'

declare module 'koishi' {
  interface Channel {
    rss: string[]
  }

  interface Modules {
    rss: typeof import('.')
  }
}

const logger = new Logger('rss')

export const name = 'RSS'
export const inject = ['database'] as const

export interface Config {
  timeout?: number
  refresh?: number
  userAgent?: string
}

export const Config: Schema<Config> = Schema.object({
  timeout: Schema.number().description('请求数据的最长时间。').default(Time.second * 10),
  refresh: Schema.number().description('刷新数据的时间间隔。').default(Time.minute),
  userAgent: Schema.string().description('请求时使用的 User Agent。'),
})

const extractAdditions = (patch) => {
    // 将 patch 分割成单独的行
    const lines = patch.split('\n');
    
    // 过滤出以 '+' 开头但不是 '+++' 的行，因为 '+++' 是文件头部信息的一部分
    const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++'))
                           .map(line => line.slice(1)); // 去除 '+' 前缀
    
    return additions;
};

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('channel', {
    rss: 'list',
  })

  const { timeout, refresh, userAgent } = config
  const feedMap: Record<string, Set<string>> = {}
  const feeder = new RssFeedEmitter({ skipFirstLoad: true, userAgent })

  function subscribe(url: string, guildId: string) {
    if (url in feedMap) {
      feedMap[url].add(guildId)
    } else {
      feedMap[url] = new Set([guildId])
      feeder.add({ url, refresh })
      logger.debug('subscribe', url)
    }
  }

  function unsubscribe(url: string, guildId: string) {
    feedMap[url].delete(guildId)
    if (!feedMap[url].size) {
      delete feedMap[url]
      feeder.remove(url)
      logger.debug('unsubscribe', url)
    }
  }

  ctx.on('dispose', () => {
    feeder.destroy()
  })

  feeder.on('error', (err: Error) => {
    logger.debug(err.message)
  })

  feeder.on('new-item', async (payload) => {
    console.debug('receive')
    const source = payload.meta.link
    // if (!feedMap[source]) return
    // const message = `${payload.meta.title} (${payload.author})\n${payload.title}`
    
    const itemLink = payload.link; // 这里获取的是单个条目的链接
    // 解析出 commit ID 和仓库路径
    const commitId = itemLink.split('/').pop();
    const repoPath = itemLink.match(/github\.com\/([^\/]+\/[^\/]+)/)[1];
    // 构建 API URL 和 headers
    const apiUrl = `https://api.github.com/repos/${repoPath}/commits/${commitId}`;
    console.debug(apiUrl);
    const headers = {
    'Authorization': 'token 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', // 替换成你的 GitHub token
    'Accept': 'application/vnd.github.v3+json'
  };

    try {
        var response = await axios.get(apiUrl, { headers });
        // console.log(commitDetails); // 此处处理获取到的提交详情数据
    } catch (error) {
        console.error("Error fetching commit details:", error);
    }
    let message = '你有新的大学夏令营信息！（机器人信息~）\n';
    response.data.files.forEach(file => {
      if (file.patch) { // 确保有 patch 数据
      const additions = extractAdditions(file.patch);
      additions.forEach(addition => {
        message += addition + '\n';
      });
      }
    });

  //   let message;
  //   commitDetails.files.forEach(file => {
  //   if (file.patch) { // 确保有 patch 数据
  //       const additions = extractAdditions(file.patch);
  //       console.log(`File: ${file.filename}`);
  //       additions.forEach((addition, index) => {
  //           console.log(`Addition ${index + 1}:`, addition);
  //           message += addition + '\n';
  //       });
  //   }});

  await ctx.broadcast([...feedMap[source]], message)
  })

  ctx.on('ready', async () => {
    const channels = await ctx.database.getAssignedChannels(['platform', 'id', 'rss'])
    for (const channel of channels) {
      for (const url of channel.rss) {
        subscribe(url, `${channel.platform}:${channel.id}`)
      }
    }
  })

  const validators: Record<string, Promise<unknown>> = {}
  async function validate(url: string, session: Session) {
    if (validators[url]) {
      await session.send('正在尝试连接……')
      return validators[url]
    }

    let timer: NodeJS.Timeout
    const feeder = new RssFeedEmitter({ userAgent })
    return validators[url] = new Promise((resolve, reject) => {
      // rss-feed-emitter's typings suck
      feeder.add({ url, refresh: 1 << 30 })
      feeder.on('new-item', resolve)
      feeder.on('error', reject)
      timer = setTimeout(() => reject(new Error('connect timeout')), timeout)
    }).finally(() => {
      feeder.destroy()
      clearTimeout(timer)
      delete validators[url]
    })
  }

  ctx.guild()
    .command('rss <url:text>', '订阅 RSS 链接')
    .channelFields(['rss', 'id', 'platform'])
    .option('list', '-l 查看订阅列表')
    .option('remove', '-r 取消订阅')
    .action(async ({ session, options }, url) => {
      const { rss, id, platform } = session.channel
      if (options.list) {
        if (!rss.length) return '未订阅任何链接。'
        return rss.join('\n')
      }

      const index = rss.indexOf(url)

      if (options.remove) {
        if (index < 0) return '未订阅此链接。'
        rss.splice(index, 1)
        unsubscribe(url, `${platform}:${id}`)
        return '取消订阅成功！'
      }

      if (index >= 0) return '已订阅此链接。'
      return validate(url, session).then(() => {
        subscribe(url, `${platform}:${id}`)
        if (!rss.includes(url)) {
          rss.push(url)
          return '添加订阅成功！'
        }
      }, (error) => {
        logger.debug(error)
        console.error(error)
        return '无法订阅此链接。'
      })
    })
}
