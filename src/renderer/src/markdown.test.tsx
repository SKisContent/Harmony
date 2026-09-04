import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { type MdContext, renderContent } from './markdown'

const ctx: MdContext = {
  mentions: new Map([
    ['111', 'alice'],
    ['222', 'bob']
  ]),
  channels: new Map([['333', 'general']])
}

function draw(src: string): HTMLElement {
  render(<div data-testid="md">{renderContent(src, ctx)}</div>)
  return screen.getByTestId('md')
}

describe('markdown — inline', () => {
  it('renders emphasis marks', () => {
    const el = draw('**bold** _italic_ __under__ ~~strike~~')
    expect(el.querySelector('strong')).toHaveTextContent('bold')
    expect(el.querySelector('em')).toHaveTextContent('italic')
    expect(el.querySelector('u')).toHaveTextContent('under')
    expect(el.querySelector('s')).toHaveTextContent('strike')
  })

  it('renders inline code without parsing its contents', () => {
    const el = draw('run `a ** b` now')
    const code = el.querySelector('code.md-code')!
    expect(code).toHaveTextContent('a ** b')
    expect(code.querySelector('strong')).toBeNull()
  })

  it('resolves user and channel mentions', () => {
    const el = draw('hey <@111> see <#333> and <@&9>')
    const mentions = [...el.querySelectorAll('.md-mention')].map((n) => n.textContent)
    expect(mentions).toEqual(['@alice', '#general', '@role'])
  })

  it('renders @everyone / @here as mentions', () => {
    const el = draw('@everyone and @here')
    expect(el.querySelectorAll('.md-mention')).toHaveLength(2)
  })

  it('renders custom and animated emoji as CDN images', () => {
    const el = draw('<:blob:12345> <a:spin:67890>')
    const imgs = [...el.querySelectorAll('img.md-emoji')].map((i) => i.getAttribute('src'))
    expect(imgs[0]).toContain('/emojis/12345.png')
    expect(imgs[1]).toContain('/emojis/67890.gif')
  })

  it('linkifies masked and bare links', () => {
    const el = draw('[site](https://example.com) and https://bare.test/x done')
    const links = [...el.querySelectorAll('a')]
    expect(links[0]).toHaveAttribute('href', 'https://example.com')
    expect(links[0]).toHaveTextContent('site')
    expect(links[1]).toHaveAttribute('href', 'https://bare.test/x')
  })

  it('recurses into nested marks', () => {
    const el = draw('nested **bold `code` <@222>** tail')
    const strong = el.querySelector('strong')!
    expect(strong.querySelector('code')).toHaveTextContent('code')
    expect(strong.querySelector('.md-mention')).toHaveTextContent('@bob')
  })
})

describe('markdown — blocks', () => {
  it('renders headings', () => {
    const el = draw('# One\n## Two\nbody')
    expect(el.querySelector('h1.md-h')).toHaveTextContent('One')
    expect(el.querySelector('h2.md-h')).toHaveTextContent('Two')
    expect(el.querySelector('.md-p')).toHaveTextContent('body')
  })

  it('merges consecutive blockquote lines', () => {
    const el = draw('> line one\n> line two\nplain')
    expect(el.querySelector('blockquote.md-quote')).toHaveTextContent('line one line two')
    expect(el.querySelector('.md-p')).toHaveTextContent('plain')
  })

  it('renders fenced code blocks verbatim', () => {
    const el = draw('```js\nconst x = 1\n```')
    const pre = el.querySelector('pre.md-pre code')!
    expect(pre).toHaveTextContent('const x = 1')
  })

  it('returns nothing for empty input', () => {
    const el = draw('')
    expect(el).toBeEmptyDOMElement()
  })
})

describe('markdown — spoiler', () => {
  it('reveals on click', async () => {
    const user = userEvent.setup()
    const el = draw('secret ||hidden|| end')
    const spoiler = el.querySelector('.md-spoiler')!
    expect(spoiler).not.toHaveClass('revealed')
    await user.click(spoiler)
    expect(el.querySelector('.md-spoiler')).toHaveClass('revealed')
  })
})
