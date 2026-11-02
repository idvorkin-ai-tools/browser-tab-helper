// R6: a tab group as a message anyone can read and click, and the reverse: any text with links as a group.
import { normalizeUrl } from './normalize.js';
import { cleanTitle } from './titles.js';

export function formatSection(name, tabs) {
  const lines = tabs.map((tab) => `• ${cleanTitle(tab.title) || tab.url} — ${tab.url}`);
  return [`📂 ${name}`, ...lines].join('\n');
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'\]]+/g;
const BULLET = /^\s*(?:[•*\-–—+]|\d+[.)])\s+/;
const HEADING_MARK = /^\s*(?:📂|#+)\s*/u;

// A URL in prose often ends with punctuation that is not part of it, or a closing bracket it never opened.
function trimUrl(url) {
  let trimmed = url.replace(/[.,;:!?]+$/, '');
  while (trimmed.endsWith(')') && count(trimmed, '(') < count(trimmed, ')')) {
    trimmed = trimmed.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return trimmed;
}

function count(text, char) {
  return text.split(char).length - 1;
}

function isLink(url) {
  try {
    return new URL(url).protocol.startsWith('http');
  } catch {
    return false;
  }
}

function linesLinks(line) {
  const found = [];
  const masked = line.replace(MARKDOWN_LINK, (match, title, url) => {
    found.push({ title: title.trim(), url });
    return ' '.repeat(match.length);
  });
  const bare = [...masked.matchAll(BARE_URL)];
  bare.forEach((match) => {
    const url = trimUrl(match[0]);
    // On a line with a single bare URL, the rest of the line is its title: `• Title — https://…`.
    const rest = bare.length === 1 && !found.length
      ? masked.replace(match[0], ' ').replace(BULLET, '').replace(/\s*[—–:|-]+\s*$/, '').replace(/^\s*[—–:|-]+\s*/, '').trim()
      : '';
    found.push({ title: rest, url });
  });
  return found.filter((link) => isLink(link.url));
}

function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

/** { name, links: [{ title, url }] } from any text with links. The first line names it. */
export function parseSection(text) {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const links = [];
  const seen = new Set();
  for (const line of lines) {
    for (const link of linesLinks(line)) {
      const key = normalizeUrl(link.url) ?? link.url;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }
  if (!links.length) return { name: '', links };

  const [firstLine] = lines;
  const firstLinks = linesLinks(firstLine);
  const name = firstLinks.length
    ? firstLinks[0].title || hostOf(firstLinks[0].url)
    : firstLine.replace(HEADING_MARK, '').replace(BULLET, '').trim();
  return { name, links };
}
