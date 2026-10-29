export type ImportMode = 'archive' | 'file' | 'history';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function link(text: string, href: string) {
  const node = el('a', 'jar-guide-link', text); node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
}
function detail(title: string, paragraphs: string[]) {
  const node = el('details', 'jar-guide-details'); node.append(el('summary', '', title));
  for (const paragraph of paragraphs) node.append(el('p', 'jar-help', paragraph));
  return node;
}
function list(items: string[]) {
  const node = el('ol', 'jar-guide-tutorial');
  for (const item of items) node.append(el('li', 'jar-help', item));
  return node;
}

/** Local orientation only: tutorial navigation never connects to JAR or imports data. */
export function createImportGuide(options: { start(mode: ImportMode): void }) {
  let disposed = false, busy = false, current = 0;
  const root = el('section', 'jar-guide'); root.setAttribute('aria-label', 'Import guide');
  root.append(el('h2', '', 'Import your old chats and cards.'), el('p', 'jar-intro', 'Bring a character card here, then add your old conversation if you have its history. Choose the route that fits your device.'));
  const platform = el('aside', 'jar-guide-platform'); platform.setAttribute('aria-label', 'JAR device requirements');
  platform.append(el('strong', '', 'JAR needs a computer'), el('p', 'jar-help', 'JAR runs on Windows, macOS or Linux with a graphical desktop. It does not run directly on phones or tablets. Termux is unsupported.'));
  const routes = el('div', 'jar-guide-routes'); routes.setAttribute('role', 'group'); routes.setAttribute('aria-label', 'Choose your import guide');
  const computerRoute = el('button', 'jar-guide-route', 'Use JAR on a computer'); computerRoute.type = 'button'; computerRoute.setAttribute('aria-controls', 'jar-computer-guide');
  const fileRoute = el('button', 'jar-guide-route', 'Phone or tablet · card file'); fileRoute.type = 'button'; fileRoute.setAttribute('aria-controls', 'jar-mobile-guide');
  routes.append(computerRoute, fileRoute); root.append(platform, routes);
  const mobile = el('section', 'jar-guide-mobile'); mobile.id = 'jar-mobile-guide'; mobile.setAttribute('aria-label', 'Import without running JAR');
  const mobileHeading = el('h3', '', 'Get a card without installing JAR'); mobileHeading.tabIndex = -1;
  mobile.append(mobileHeading, el('p', 'jar-help', 'Open either site in your browser to look for the character. Download its character card when a download is available, then return here.'));
  const alternatives = el('div', 'jar-guide-alternatives');
  const janny = el('div'); janny.append(link('Open JannyAI ↗', 'https://jannyai.com/'), el('p', 'jar-help', 'On the JanitorAI character page, replace janitorai.com with jannyai.com in the address, keeping the rest of the link. Download the card if it is available.'));
  const datacat = el('div'); datacat.append(link('Open DataCat ↗', 'https://datacat.run/'), el('p', 'jar-help', 'Search for the character or creator, open the matching card and use its download option when available. Some records redirect to the original site instead.'));
  const sucker = el('div'); sucker.append(link('Open Sucker ↗', 'https://sucker.severian.dev/'), el('p', 'jar-help', 'Works as a proxy in JanitorAI’s API settings: chat with the character and it extracts the card along with the lorebook entries your messages trigger, including closed ones. Follow the instructions on its page. It only works when the creator allows proxies.'));
  alternatives.append(janny, datacat, sucker);
  const mobileImport = el('button', 'jar-button jar-primary', 'Choose a downloaded card'); mobileImport.type = 'button';
  mobileImport.addEventListener('click', () => { if (!disposed && !busy) options.start('file'); });
  mobile.append(alternatives, el('p', 'jar-help', 'Save a PNG or JSON character card to your device’s Downloads or Files, then choose it below. A saved portrait or screenshot is not a character card. You review the card before importing it.'), mobileImport,
    el('p', 'jar-help jar-guide-note', 'Want your old conversation too? These card downloads do not bring your private JanitorAI chat history. After the card, add a JAR .json or SillyTavern .jsonl history file you already have, or use JAR on a computer to retrieve your chat.'),
    el('p', 'jar-help', 'Card availability and completeness depend on the site and the creator’s settings. If one site has no download, try the other or use a card file you already have.'),
    el('p', 'jar-help', 'Got a lorebook file from Sucker or elsewhere? Import it from Lumiverse’s World Info panel, then attach it to the character there.'));
  root.append(mobile);
  const journey = el('ol', 'jar-guide-journey'); journey.setAttribute('aria-label', 'How the transfer works');
  for (const [name, description] of [
    ['JanitorAI', 'Your original character and chat'],
    ['JAR', 'Prepares the content you want to move'],
    ['Lumiverse', 'Saves your card and chat here'],
  ]) {
    const item = el('li'); item.append(el('strong', '', name), el('span', '', description)); journey.append(item);
  }
  const definitions = el('div', 'jar-guide-definitions');
  for (const [name, description] of [
    ['Character card', 'Who the character is: their instructions, greetings and portrait.'],
    ['Chat history', 'What you already said to each other: the conversation’s messages.'],
  ]) {
    const item = el('p'); item.append(el('strong', '', name), el('span', '', description)); definitions.append(item);
  }
  const tutorial = el('section', 'jar-guide-walkthrough'); tutorial.id = 'jar-computer-guide'; tutorial.setAttribute('aria-label', 'First-time walkthrough');
  const tutorialHeader = el('div', 'jar-guide-walkthrough-heading');
  tutorialHeader.append(el('h3', '', 'First time? Follow these steps.'));
  const progress = el('span', 'jar-guide-progress'); tutorialHeader.append(progress);
  const navigation = el('nav', 'jar-guide-navigation'); navigation.setAttribute('aria-label', 'Tutorial steps');
  const panels = el('div', 'jar-guide-panels');
  const buttons: HTMLButtonElement[] = [computerRoute, fileRoute, mobileImport], stepButtons: HTMLButtonElement[] = [], headings: HTMLHeadingElement[] = [], sections: HTMLElement[] = [];
  const shortNames = ['How it works', 'Open JAR', 'Sign in', 'Card', 'Chat', 'Import'];
  const titles = ['What is JAR?', 'Open the separate JAR app', 'Sign in through JAR', 'Load your character card', 'Load your old conversation', 'Review and save into Lumiverse'];
  const locations = ['THE TRANSFER', 'IN JAR · SETUP', 'IN JAR · SETUP', 'IN LUMIVERSE', 'IN LUMIVERSE', 'IN LUMIVERSE'];
  for (let index = 0; index < titles.length; index++) {
    const button = el('button', 'jar-guide-step-button', index === 0 ? shortNames[index] : `${index}. ${shortNames[index]}`); button.type = 'button';
    button.setAttribute('aria-controls', `jar-guide-step-${index + 1}`);
    button.addEventListener('click', () => showStep(index, true));
    stepButtons.push(button); buttons.push(button); navigation.append(button);
    const section = el('section', 'jar-guide-page'); section.id = `jar-guide-step-${index + 1}`;
    const heading = el('h4', '', titles[index]); heading.id = `jar-guide-heading-${index + 1}`; heading.tabIndex = -1;
    section.setAttribute('aria-labelledby', heading.id); section.append(el('div', 'jar-guide-location', locations[index]), heading);
    sections.push(section); headings.push(heading); panels.append(section);
  }

  sections[0].append(el('p', 'jar-help', 'JAR is a separate app that reads the JanitorAI character and conversation you choose. Start it and sign in once, then paste links in this Lumiverse importer to preview and save your content here. You can stay in Lumiverse after that setup.'), journey, definitions, el('p', 'jar-help jar-guide-pair', 'To resume an old chat, bring both. If its character is already in Lumiverse, you only need the history.'));

  sections[1].append(el('p', 'jar-help', 'You are in Lumiverse right now. JAR must be running separately before a link preview or Browse saved JAR cards can work.'),
    list([
      'Get JAR from its GitHub page: Code → Download ZIP. Extract the ZIP completely, then open the extracted project folder containing package.json. If start.bat is supplied, it belongs in that same folder. Do not run JAR from inside the ZIP.',
      'On Windows, double-click start.bat when it is supplied. Give setup time and keep the console window open. If the launcher is missing or stops with an error, open “JAR will not start on Windows” below.',
      'Once the console shows JAR’s local address, open http://127.0.0.1:4577 if the page does not open for you. In this importer, choose Check JAR connection to confirm the server is running. Keep its console open; an open browser tab alone does not keep JAR running.',
    ]));
  const download = el('p', 'jar-help'); download.append(link('Get JAR · official download and setup', 'https://github.com/alpha-omicron/JAR')); sections[1].append(download);
  sections[1].append(el('p', 'jar-help jar-guide-note', 'Run JAR on the same computer as the Lumiverse server. On macOS or Linux, follow JAR’s requirements and run npm start.'), el('p', 'jar-help', 'Viewing Lumiverse on a phone while JAR is already running on its host computer? You can still load links here. Open JAR’s own interface on that computer: a 127.0.0.1 link opens the device you are viewing it on.'));
  const startupHelp = detail('JAR will not start on Windows', []);
  const nodeDownload = el('p', 'jar-help'); nodeDownload.append('Install Node.js LTS from ', link('the official Node.js download page', 'https://nodejs.org/en/download'), ', then open a new terminal so it can find Node and npm.');
  startupHelp.append(nodeDownload,
    el('p', 'jar-help', 'In File Explorer, open the extracted JAR project folder containing package.json. Right-click empty space and choose Open in Terminal (PowerShell is fine). Run these commands in order, waiting for the first to finish:'),
    el('p', 'jar-guide-example', 'npm.cmd install'),
    el('p', 'jar-guide-example', 'npm.cmd start'),
    el('p', 'jar-help', 'Use npm.cmd in PowerShell. If npm.ps1 is blocked by an execution policy, use npm.cmd instead; you do not need to change the policy.'),
    el('p', 'jar-help', 'If setup finishes but JAR reports that its Chromium browser executable is missing, stop JAR with Ctrl+C, run this command after npm.cmd install, then run npm.cmd start again:'),
    el('p', 'jar-guide-example', 'npx.cmd playwright install chromium'),
    el('p', 'jar-help', 'A missing package.json means the terminal is in the wrong folder. “node” or “npm.cmd” not recognized means Node.js is not installed or the terminal needs reopening. Keep the console open and read the first error if startup still fails.'));
  sections[1].append(startupHelp);

  sections[2].append(el('p', 'jar-help', 'JAR uses its own browser to read your selected conversation. Being signed into JanitorAI in your usual browser is not enough. A newly extracted JAR copy has its own login session and saved-card folder. Connection checks work before signing in.'),
    list([
      'In JAR’s top bar, click log in (🔓).',
      'A separate browser opens. Sign into JanitorAI there, then return to this Lumiverse importer.',
    ]), el('p', 'jar-help jar-guide-note', 'You do not enter your JanitorAI password in this Lumiverse importer. Leave JAR running. You do not need to prepare or link cards in JAR’s window for the next steps.'),
    el('p', 'jar-help jar-guide-note', 'Your own account is only needed to read your own chat histories. Once you have brought them over, sign JAR into a throwaway JanitorAI account instead, especially before capturing closed lorebooks: capture sends messages from whichever account JAR is signed into.'));

  sections[3].append(el('p', 'jar-help', 'Use the character’s page link for this step, not the conversation link.'),
    el('p', 'jar-guide-example', 'Character link: janitorai.com/characters/…'),
    list([
      'Open the character on JanitorAI and copy the page address.',
      'Choose Paste a JanitorAI link below. In this importer, paste the address into JanitorAI character or chat link and choose Preview link.',
      'Review the character’s definition and portrait here, then choose Import to Lumiverse. A link preview does not save a Lumiverse character until you choose Import.',
    ]), el('p', 'jar-help jar-guide-note', 'A hidden definition may leave an incomplete card. See “My card is incomplete” below. If the character is already in Lumiverse, skip this step.'));

  sections[4].append(el('p', 'jar-help', 'Now use the link to the specific conversation you want to continue.'),
    el('p', 'jar-guide-example', 'Conversation link: janitorai.com/chats/…'),
    list([
      'Open your old conversation on JanitorAI and copy its address containing /chats/<id>.',
      'Choose Paste a JanitorAI link below and paste the conversation address into JanitorAI character or chat link. Choose Preview link; JAR loads that selected conversation in the background.',
      'If its card is available, review and import it first, then choose Next: import chat history. The loaded history follows automatically. If the card is incomplete, review the history and choose its existing Lumiverse character, or Get this character’s card.',
    ]), el('p', 'jar-help jar-guide-note', 'You do not need to create or link the conversation in JAR’s window first. Preview link reads your selected conversation; it does not send a chat message or import anything into Lumiverse.'));

  sections[5].append(el('p', 'jar-help', 'Once Preview link has loaded your card or conversation, finish the transfer here. You do not need to download files for this route.'),
    list([
      'Review the character card and choose Import to Lumiverse if you need it in your library.',
      'Choose Next: import chat history when shown. A conversation loaded from your pasted link is already available for review; you do not need to load or paste it again.',
      'Already have the character? Use an existing character for this chat skips the card import. Review the messages and destination character, then choose Import chat → Continue chat.',
    ]), el('p', 'jar-help jar-guide-note', 'This creates a normal Lumiverse character and a new chat. Your existing chats stay separate. Lumiverse’s usual API, prompts and other settings handle your next replies.'));

  const controls = el('div', 'jar-guide-controls');
  const previous = el('button', 'jar-link', '← Previous'); previous.type = 'button';
  const next = el('button', 'jar-button jar-primary'); next.type = 'button';
  previous.addEventListener('click', () => showStep(current - 1, true)); next.addEventListener('click', () => showStep(current + 1, true));
  controls.append(previous, next); buttons.push(previous, next);
  tutorial.append(tutorialHeader, navigation, panels, controls); root.append(tutorial);

  const readyHeading = el('h3', 'jar-guide-ready', 'Already prepared? Start importing here.'); root.append(readyHeading);
  const actions = el('div', 'jar-guide-actions');
  for (const [label, mode, cls] of [
    ['Paste a JanitorAI link', 'archive', 'jar-button jar-primary'],
    ['I already have exported files', 'file', 'jar-button'],
    ['My character is already in Lumiverse', 'history', 'jar-link'],
  ] as const) {
    const button = el('button', cls, label); button.type = 'button';
    button.addEventListener('click', () => { if (!disposed && !busy) options.start(mode); });
    actions.append(button); buttons.push(button);
  }
  const connectionNote = el('p', 'jar-help', 'Browse saved JAR cards reads JAR’s saved character list. It does not start JAR, sign you in, or import anything automatically. You review each card and chat before saving.');
  root.append(actions, connectionNote);
  function showRoute(useFile: boolean, focus = false) {
    if (disposed || busy) return;
    mobile.hidden = !useFile; tutorial.hidden = useFile; readyHeading.hidden = useFile; actions.hidden = useFile; connectionNote.hidden = useFile;
    computerRoute.setAttribute('aria-pressed', String(!useFile)); fileRoute.setAttribute('aria-pressed', String(useFile));
    if (focus) (useFile ? mobileHeading : headings[current]).focus({ preventScroll: true });
  }
  computerRoute.addEventListener('click', () => showRoute(false, true)); fileRoute.addEventListener('click', () => showRoute(true, true));
  showRoute(false);

  root.append(detail('I have files already — do I still need JAR?', [
    'No. Choose I already have exported files and select a PNG or JSON character card (CHARX is also accepted). A PNG character card includes the portrait and character data; a plain avatar picture does not.',
    'After importing the card, choose Next: import chat history, then History file. If the character is already here, go straight to Chat history → History file.',
    'Choose a JAR JSON chat export or SillyTavern JSONL file. You can import either without JAR running. A chat-history file loads your messages; import its character card separately if the character is not yet in your library.',
  ]));
  root.append(detail('My card is incomplete', [
    'JAR’s extract button reads the available public details. A hidden definition or a linked conversation can leave a name-only character record. Check for a completed definition before importing, or use a character-card export you already have.',
    'For a hidden definition, the link preview offers Capture hidden card with JAR. After you confirm, JAR creates a temporary JanitorAI chat, sends probe messages and recovers the definition from the prompt; use a throwaway account. Recovering a card does not need JAR’s extraction LLM; only rebuilding closed lorebooks does.',
  ]));
  root.append(detail('Can’t connect, or can’t see my chat?', [
    'Can’t connect? Start JAR and keep its console open on the same computer as the Lumiverse server. The default address is http://127.0.0.1:4577. Change the address only if your JAR uses another port.',
    'Have a conversation link? Choose Chat history → From JAR, paste it into JanitorAI conversation link, then choose Load chat. Saved conversations in JAR is an optional way to browse chats you linked earlier. Missing login? Open JAR’s log in browser, sign into JanitorAI there, then retry here.',
    'Works in JAR but will not load here? Download that conversation from JAR as JSON or SillyTavern JSONL, then choose Chat history → History file. Review the messages and select the destination character before Import chat.',
    'Character not in your Lumiverse list? Import its completed card first, or select the existing Lumiverse character that should receive the imported history.',
  ]));
  root.append(detail('What comes over, and what do I set up here?', [
    'Cards bring their definition, portrait, greetings, supported metadata and embedded character lorebook. History brings messages and alternate replies, with the names and dates available in the source. Each import becomes a new normal Lumiverse chat.',
    'Set up your API and prompts in Lumiverse before continuing the conversation. Persona definitions and bindings are not inferred from old chat names. Lorebooks are listed after a character link preview. Public ones are imported and attached with the character card; closed ones need an explicit capture and rebuild first.',
  ]));

  function showStep(index: number, focus = false) {
    if (disposed || busy || index < 0 || index >= sections.length) return;
    current = index; progress.textContent = index === 0 ? 'Overview' : `${index} / ${sections.length - 1}`;
    for (let item = 0; item < sections.length; item++) {
      sections[item].hidden = item !== index;
      if (item === index) stepButtons[item].setAttribute('aria-current', 'step'); else stepButtons[item].removeAttribute('aria-current');
    }
    previous.hidden = index === 0; next.hidden = index === sections.length - 1;
    next.textContent = index < sections.length - 1 ? `Next: ${shortNames[index + 1]} →` : '';
    if (focus) {
      headings[index].focus({ preventScroll: true });
      tutorial.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }
  showStep(0);
  return {
    root,
    /** Jump to the JAR setup steps, e.g. after a failed connection check. */
    showSetup() { if (disposed || busy) return; showRoute(false); showStep(1); },
    setBusy(value: boolean) { if (disposed) return; busy = value; for (const button of buttons) button.disabled = value; },
    destroy() { if (disposed) return; disposed = true; root.remove(); },
  };
}
