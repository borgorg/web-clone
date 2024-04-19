import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { dirname, extname, join } from 'path'
import 'playwright'
import { Page, chromium, Request } from 'playwright'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

function newBrowser() {
  let p = chromium.launch({
    headless: false,
  })
  getBrowser = () => p
  return p
}

let getBrowser = newBrowser

export async function scanWeb(options: {
  dir: string
  listFile: string
  url: string
  scrollInDetail: boolean
}) {
  let { dir, url, listFile } = options
  let fileList = loadListFile(listFile)
  let browser = await getBrowser()
  let page = await browser.newPage()
  for (;;) {
    await downloadPage({
      dir,
      url,
      scrollInDetail: options.scrollInDetail,
      page,
      onPageLink: url => {
        addToFileList({
          listFile,
          fileList,
          url,
        })
      },
    })
    updateFileList({
      listFile,
      fileList,
      item: {
        status: 'saved',
        url,
      },
    })
    let next = fileList.find(item => item.status === 'pending')
    if (!next) break
    url = next.url
  }
  await page.close()
  getBrowser = newBrowser
  await browser.close()
}

type FileStatus = 'new' | 'pending' | 'saved' | 'skip'

let listFileHeader = `# possible status: new, pending, skip, saved`

type ListFileItem = {
  status: FileStatus
  url: string
}

function listFileItemToLine(item: ListFileItem): string {
  return `${item.status} ${item.url}`
}

function loadListFile(file: string): ListFileItem[] {
  if (!existsSync(file)) return []
  return readFileSync(file)
    .toString()
    .split('\n')
    .map(line => line.trim().split(' '))
    .filter(parts => parts.length == 2)
    .map(parts => {
      return {
        status: parts[0] as any,
        url: parts[1],
      }
    })
}

function updateFileList(options: {
  listFile: string
  fileList: ListFileItem[]
  item: ListFileItem
}) {
  let { listFile } = options
  let { status, url } = options.item
  let updated = false
  let found = false
  for (let item of options.fileList) {
    if (item.url == url) {
      found = true
      if (item.status !== status) {
        item.status = status
        updated = true
      }
    }
  }
  if (updated) {
    let content = options.fileList.map(listFileItemToLine).join('\n') + '\n'
    writeFileSync(listFile, content)
  } else if (!found) {
    let { item } = options
    if (options.fileList.length === 0) {
      appendFileSync(listFile, listFileHeader + '\n')
    }
    options.fileList.push(item)
    appendFileSync(listFile, listFileItemToLine(item) + '\n')
  }
}

function addToFileList(options: {
  listFile: string
  fileList: ListFileItem[]
  url: string
}) {
  let { listFile, url } = options
  if (options.fileList.some(item => item.url == url)) return
  console.log('add page link:', url)
  let item: ListFileItem = { status: 'new', url }
  if (options.fileList.length === 0) {
    appendFileSync(listFile, listFileHeader + '\n')
  }
  options.fileList.push(item)
  appendFileSync(listFile, listFileItemToLine(item) + '\n')
}

let resourceExtnameList = [
  '.css',
  '.js',
  '.woff2',
  '.svg',
  '.png',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp4',
  '.json',
  '.php',
  '.pdf',
]

async function downloadPage(options: {
  dir: string
  url: string
  scrollInDetail: boolean
  page: Page
  onPageLink: (url: string) => void
}) {
  let { page } = options
  let url = new URL(options.url)
  let file = pathnameToFile(options.dir, url.pathname)
  // if (existsSync(file)) return
  console.log('download page:', options.url)
  let origin = url.origin
  let saved = false
  async function onRequest(req: Request) {
    if (req.method() != 'GET') return
    let url = new URL(req.url())
    if (url.origin !== origin) return
    if (url.href == options.url) return
    let pathname = url.pathname
    if (pathname.endsWith('/')) {
      // another html page
      return options.onPageLink(url.href)
    }
    let ext = extname(pathname)
    if (resourceExtnameList.includes(ext)) {
      await downloadFile({ dir: options.dir, url: url.href })
      if (saved) {
        await savePage()
      }
      return
    }
    console.log('unknown ext:', ext, 'url:', url.href)
  }
  page.on('request', onRequest)
  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  if (options.scrollInDetail) {
    console.log('scrolling page:', options.url)
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        let visited = new Set()
        loop()
        function loop() {
          let nodes = document.querySelectorAll('body *')
          let i = 0
          let hasNew = false
          tick()
          function tick() {
            for (; i < nodes.length; ) {
              let node = nodes[i]
              i++
              if (visited.has(node)) continue
              visited.add(node)
              hasNew = true
              node.scrollIntoView({ behavior: 'instant' })
              requestAnimationFrame(tick)
              return
            }
            if (hasNew) {
              loop()
            } else {
              resolve()
            }
          }
        }
      })
    })
  } else {
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        Array.from(document.querySelectorAll('body *'), node => ({
          node,
          top: node.getBoundingClientRect().top,
        }))
          .sort((a, b) => b.top - a.top)[0]
          .node.scrollIntoView({ behavior: 'smooth' })
        let smoothScrollDelay = 1000
        setTimeout(resolve, smoothScrollDelay)
      })
    })
  }
  page.off('request', onRequest)
  let resLinks = await page.evaluate(() => {
    let links: string[] = []
    function checkLink(link: string | undefined) {
      if (!link) return
      console.log('link:', link)
      if (new URL(link).origin != location.origin) return
      links.push(link)
    }
    document
      .querySelectorAll<HTMLImageElement>('img,video,audio,script')
      .forEach(node => {
        checkLink(node.src)
        let lazySrc = node.dataset.lazySrc
        if (lazySrc?.[0] == '/') {
          lazySrc = location.origin + lazySrc
        }
        checkLink(lazySrc)
      })
    document
      .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
      .forEach(node => {
        checkLink(node.href)
      })
    return links
  })
  let pageLinks = await page.evaluate(() => {
    let links = new Set<string>()
    document.querySelectorAll('a').forEach(a => {
      let link = a.href
      if (!link) return
      if (new URL(link).origin != location.origin) return
      let href = link.replace(location.origin, '')
      if (a.getAttribute('href') !== href) {
        a.setAttribute('href', href)
      }
      link = link.split('#')[0]
      links.add(link)
    })
    return Array.from(links)
  })
  for (let link of pageLinks) {
    if (link == options.url) continue
    let ext = extname(new URL(link).pathname)
    if (resourceExtnameList.includes(ext)) {
      resLinks.push(link)
      continue
    }
    options.onPageLink(link)
  }
  for (let link of resLinks) {
    await downloadFile({ dir: options.dir, url: link })
  }
  async function savePage() {
    let html = await page.evaluate(() => {
      return (
        '<!DOCTYPE html>\n' +
        document.documentElement.outerHTML.replaceAll(
          location.origin + '/',
          '/',
        )
      )
    })
    console.log('save page:', options.url)
    saveFile(file, html)
  }
  await savePage()
  saved = true
}

async function downloadFile(options: { dir: string; url: string }) {
  let file = pathnameToFile(options.dir, new URL(options.url).pathname)
  if (existsSync(file)) return
  console.log('download file:', options.url)
  let res = await fetch(options.url)
  mkdirForFile(file)
  let stream = createWriteStream(file)
  await finished(Readable.fromWeb(res.body as any).pipe(stream))
}

function saveFile(file: string, content: string | Buffer) {
  mkdirForFile(file)
  writeFileSync(file, content)
}

function mkdirForFile(file: string) {
  let dir = dirname(file)
  mkdirSync(dir, { recursive: true })
}

function pathnameToFile(dir: string, pathname: string) {
  if (pathname.endsWith('/')) {
    pathname += 'index.html'
  }
  return join(dir, pathname)
}
