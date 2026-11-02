#!/usr/bin/env node
// R8. Sends one command through the bridge and prints the answer.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_PORT } from './bridge.js';

const USAGE = `usage: node tools/ask.js <command> [args] [--tab <id>] [--port <n>]

  diag                  extension state
  tabs                  every open tab
  duplicates            groups of tabs on the same page
  activate <tab>        focus a tab
  close <tab>           close a tab
  open <url>            open a new tab
  navigate <url>        send a tab to a URL (--tab, or the front tab)
  reload                reload a tab (--tab, or the front tab)
  layout                the current layout as JSON
  restore-layout <file> rebuild a layout file in new windows
  read                  page text plus numbered controls, every frame
  click <index|label>   click a control from read
  type <text>           type into the focused field
  key <key>             press a key, such as Enter or Escape
  screenshot [--out f]  save the front tab of the tab's window as a PNG

  '{"cmd":"…", …}'      anything else, as raw JSON`;

function take(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

/** The command to send, from command-line words. */
export function parseArgs(argv, { readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const args = [...argv];
  const port = Number(take(args, '--port') ?? process.env.BRIDGE_PORT ?? DEFAULT_PORT);
  const tabFlag = take(args, '--tab');
  const out = take(args, '--out');
  const [cmd, ...rest] = args;
  if (!cmd) throw new Error(USAGE);
  const tab = tabFlag === undefined ? {} : { tab: Number(tabFlag) };
  const needs = (what) => {
    if (!rest.length) throw new Error(`${cmd} needs ${what}`);
    return rest.join(' ');
  };

  let command;
  if (cmd.trimStart().startsWith('{')) {
    command = JSON.parse(cmd);
  } else {
    switch (cmd) {
      case 'diag': case 'tabs': case 'duplicates': case 'layout':
        command = { cmd };
        break;
      case 'activate': case 'close':
        command = { cmd, tab: Number(needs('a tab id')) };
        break;
      case 'open':
        command = { cmd, url: needs('a URL') };
        break;
      case 'navigate':
        command = { cmd, url: needs('a URL'), ...tab };
        break;
      case 'reload': case 'read': case 'screenshot':
        command = { cmd, ...tab };
        break;
      case 'restore-layout':
        command = { cmd, layout: JSON.parse(readFile(needs('a file'))) };
        break;
      case 'click': {
        const target = needs('an index or a label');
        command = { cmd, target: /^\d+$/.test(target) ? Number(target) : target, ...tab };
        break;
      }
      case 'type':
        command = { cmd, text: needs('text'), ...tab };
        break;
      case 'key':
        command = { cmd, key: needs('a key'), ...tab };
        break;
      default:
        throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
    }
  }
  return { port, command, out };
}

async function main() {
  const { port, command, out } = parseArgs(process.argv.slice(2));
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', body: JSON.stringify(command) });
  } catch {
    throw new Error(`No bridge on port ${port}. Start it with: node tools/bridge.js`);
  }
  const answer = await response.json();
  if (answer.error !== undefined) throw new Error(answer.error);

  if (command.cmd === 'screenshot' && answer.result?.dataUrl) {
    const path = out ?? 'screenshot.png';
    writeFileSync(path, Buffer.from(answer.result.dataUrl.split(',')[1], 'base64'));
    console.log(path);
    return;
  }
  console.log(JSON.stringify(answer.result, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
