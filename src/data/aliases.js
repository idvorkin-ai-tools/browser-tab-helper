// R3. Alias rules: destinations with several front doors.
//   name             what the card calls the destination
//   canonical        the URL to go to
//   canonicalPattern regex (string) for URLs that already are the canonical door
//   otherDoors       regexes (strings) for the other doors
//
// ponytail: the issue's optional declarativeNetRequest redirect is left out, so every other door shows the card, one
// keypress from the canonical URL. To skip the card, add the permission, top-level-only redirect rules, and a test
// holding each redirect's target equal to its rule's `canonical`.
export const ALIAS_RULES = [
  {
    name: 'Gmail',
    canonical: 'https://mail.google.com/mail/u/0/',
    canonicalPattern: '^https://mail\\.google\\.com/',
    otherDoors: ['^https://(www\\.)?gmail\\.com/', '^https://inbox\\.google\\.com/'],
  },
  {
    name: 'Google Calendar',
    canonical: 'https://calendar.google.com/calendar/u/0/r',
    canonicalPattern: '^https://calendar\\.google\\.com/',
    otherDoors: ['^https://(www\\.)?google\\.com/calendar'],
  },
];
