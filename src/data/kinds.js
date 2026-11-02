// R4. The By kind lens. First match wins and a host also matches its subdomains, so list the more specific
// hosts in the earlier rule (docs.github.com under Docs, before github.com under Code).
export const KIND_RULES = [
  {
    name: 'Dev servers',
    hosts: ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'local'],
  },
  {
    name: 'Docs',
    hosts: ['docs.google.com', 'docs.github.com', 'developer.mozilla.org', 'readthedocs.io', 'notion.so', 'wikipedia.org'],
  },
  {
    name: 'Code',
    hosts: ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'stackoverflow.com'],
  },
  {
    name: 'Chat',
    hosts: ['slack.com', 'discord.com', 'teams.microsoft.com', 'web.whatsapp.com', 'chatgpt.com', 'claude.ai'],
  },
  {
    name: 'Mail',
    hosts: ['mail.google.com', 'gmail.com', 'outlook.live.com', 'calendar.google.com'],
  },
  {
    name: 'Video',
    hosts: ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv'],
  },
];
