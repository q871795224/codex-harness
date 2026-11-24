import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { isOpenableExternalUrl } from './MarkdownLink'

export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'href' && node.tagName === 'a' && isOpenableExternalUrl(url)) return url
  return defaultUrlTransform(url)
}
