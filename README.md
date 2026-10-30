# JAR Bridge

Import character cards, lorebooks and old conversations into Lumiverse with an optional walkthrough, local previews, and a clear destination picker. JAR Bridge works on its own or alongside [Janiverse](https://github.com/lunchberrymail-cmyk/Janiverse).

This is an unofficial bridge for [alpha-omicron/JAR](https://github.com/alpha-omicron/JAR). It is not affiliated with JanitorAI or JAR. JAR is a separate application; installing this extension does not install or start it.

## What you can import

| Source | What it brings | Needs JAR running? |
| --- | --- | --- |
| JanitorAI character link | The available character definition and portrait | Yes |
| JanitorAI conversation link | The selected conversation, plus its character card when available | Yes |
| PNG, JSON or CHARX character card | Character definition and supported card data; portraits when included | No |
| JAR JSON or SillyTavern JSONL history file | Messages and alternate replies for a character you choose | No |
| Lorebooks of a previewed JanitorAI character | Public lorebooks, and closed ones JAR captured and rebuilt | Yes |

A character card and a conversation are different things. Bring both to resume an old chat, or import only the history if its character is already in your Lumiverse library. A portrait or screenshot by itself is not a character card.

## Install

Requires **Lumiverse 1.2.5 or later**. Install the repository through Lumiverse's Extensions window using:

```text
https://github.com/lunchberrymail-cmyk/JAR-Bridge
```

**Operator installations work with every signed-in Lumiverse account**, including ordinary users. This is the default installation used by Lumiverse Desktop. All users share the JAR instance, its signed-in JanitorAI session, and its saved archive on the server computer. Use a dedicated throwaway JanitorAI account when sharing; imports still go into the requesting user's own Lumiverse library. No manual account binding or installation-scope change is needed.

Any signed-in account can also use JAR's actions: read every saved card and conversation in JAR's archive, **delete records from JAR** (Clean up JAR), **capture** (sends messages from JAR's JanitorAI account) and **rebuild** (spends the LLM credit configured in JAR). Lumiverse decides the installation type, not the bridge, so whether to share JAR this way is the instance owner's call. To keep JAR to one account, install the extension personally instead.

**Personal/user-scoped installations** remain restricted to their owning Lumiverse account. On the first explicit connection or link preview, the extension confirms its requesting window and remembers that account automatically. Another account cannot replace an existing personal binding. File imports work without a running JAR.

Open **JAR Import** in Lumiverse's sidebar, or use Janiverse's import banner. The assistant opens with the import controls. **Help and import guide** is optional, and **Back to importer** preserves your current selection and destination. Closing and reopening the assistant preserves progress during the page session.

## Start JAR once on your computer

**JAR needs a Windows, macOS or Linux computer with a graphical desktop. It does not run directly on phones or tablets; Termux is unsupported.** Run it on the computer hosting your Lumiverse server.

1. Follow the [official JAR setup instructions](https://github.com/alpha-omicron/JAR). Extract the download completely into a folder before running it.
2. Start JAR and keep its console open. On Windows, use `start.bat` when supplied. If the launcher is missing or fails, see the manual commands below.
3. Open the local address printed by JAR, usually `http://127.0.0.1:4577`. Startup has worked when JAR's page and its character URL field appear.
4. In JAR, choose **log in**. Sign into JanitorAI in the separate browser it opens. Being signed into JanitorAI in your usual browser is not enough.
5. Return to Lumiverse. You can paste links and finish the transfer here; you do not need to prepare or link them in JAR's window first.

The first time you open the importer, its **Help and import guide** walkthrough opens and takes you through these steps. If a connection check fails, **JAR won't connect? → First time with JAR? Set it up step by step** jumps back to them.

> **Important: switch JAR to a throwaway account once your chat history is recovered.** Your main JanitorAI account is only needed to recover your own chat histories. Previews, hidden-card and lorebook captures and rebuilds run automated requests and messages from whichever account JAR is signed into, which can get your main account flagged or banned. As soon as your chats are in Lumiverse, sign out of JanitorAI in JAR's browser and log in (🔓) with a throwaway account. The importer shows this reminder after each chat it brings over from JAR, and in every capture confirmation.

Use **Check JAR connection** in the importer to verify that JAR is running. This checks its version only; it does not open JAR's browser, require a JanitorAI login, or read saved cards. **Load saved cards** is a separate action. An empty archive in a fresh download is a successful connection.

Keep JAR's console open. Closing it stops the server even if its browser tab remains open. A newly extracted JAR folder has its own login session and saved-card folder; sign in using that copy's **Log in** button before loading JanitorAI links.

For manual Windows startup, install Node.js LTS, open a terminal in the extracted JAR folder containing `package.json`, then run these commands in order:

```powershell
npm.cmd install
npm.cmd start
```

If JAR reports a missing Chromium executable, stop JAR, run `npx.cmd playwright install chromium`, then start it again. The `.cmd` commands work in PowerShell without changing its execution policy. On macOS or Linux, follow JAR's requirements and use `npm start`.

If you view Lumiverse on a phone while JAR is already running on the server computer, you can still paste links in this importer. A browser link to `127.0.0.1` opens the device you are currently viewing, so open JAR's own interface on the host computer.

## Import a card and chat

Opening **JAR Import** from the drawer opens the import assistant in a larger window. The drawer itself only offers to reopen it; **Use it in this drawer instead** keeps the full importer there.

1. In **JanitorAI link**, paste a `https://janitorai.com/characters/…` or `/chats/…` link and choose **Preview link**. **Clear** empties the field and the preview.
2. Review the character and choose **Import to Lumiverse** if you need it in your library.
3. Choose **Next: import chat history**. For a conversation link, the loaded messages follow automatically. If the character is already here, **Use an existing character for this chat** skips another card import.
4. Review the messages, choose the destination character, then choose **Import chat → Continue chat**.

**Hidden definitions.** When a creator hides a character's definition, the preview has only its public details and shows **Hidden card and lorebooks** instead. **Capture hidden card with JAR…** runs the same capture as closed lorebooks, with the same confirmation, **Your words** box and throwaway-account advice: JAR opens a temporary chat, recovers the definition from the prompt, and collects any closed lorebooks for rebuilding. The recovered card then loads from the record JAR saved for the capture (JAR keeps each capture as its own record). It is pieced together from the chat prompt, so review it before importing. It is unavailable when the creator does not allow proxies. A later preview of the same link reuses a definition JAR already recovered.

For history only, open **Chat history → From JAR**, paste the conversation URL into **JanitorAI conversation link**, and choose **Load chat**. Choose a Lumiverse character before importing. You do not need to connect a saved-card catalog first.

For files, choose **Import card file** for PNG/JSON/CHARX cards or **Chat history → History file** for JAR JSON/SillyTavern JSONL. You can use either file route without JAR running. A JAR JSON history export supplies messages; import the character card separately if needed.

**One JAR record per link.** JAR saves a new record every time it inspects a link, so the bridge remembers which record it used for each character link (in its own storage, kept across restarts) and reuses it, choosing the capture record once there is one. JAR only inspects a link again when that record was deleted. Public details are then not re-read on each preview; use JAR's **refresh public data** if the creator changed the page.

**Clean up JAR.** In **Cards already saved in JAR**, **Clean up JAR…** lists every JAR record with its type (link preview or capture) and date. **Select duplicate previews** picks the link previews JAR made again for characters it already has: a character's captures are always kept, and without one its newest preview is kept. **Delete … from JAR…** asks for confirmation first, and warns when a capture is included, since its captured lorebook text and any recovered hidden card are lost. Deleting only removes records from JAR: characters, chats and lorebooks already imported into Lumiverse are not touched.

**Cards already saved in JAR** and **Saved conversations in JAR** are optional, initially collapsed sections for browsing JAR's existing records. The normal address is filled in; expand **Change JAR address** only for a different local port.

## Import lorebooks

After you preview a JanitorAI character link, a **Lorebooks** section lists what JAR has for that character. Expand a book to review its entries and keywords. Books go to Lumiverse's World Info through its normal importer.

- **Public lorebooks** that JAR downloaded are imported and attached automatically when you import the character card. You can also import one on its own with **Import lorebook** before importing the card.
- **Every lorebook is listed beside the card name**, colored by where it stands: open books in green (*Open · imports with the card*, then *Attached to <character>*), closed ones in red (*CLOSED*, *CLOSED · cannot be captured*), orange (*CLOSED · captured, not rebuilt*), purple (*CLOSED · rebuilt, ready to import*) and green once imported. **Lorebook details** jumps to the steps.
- **Closed lorebooks** need two explicit steps, each with a confirmation:
  1. **Capture closed lorebook**: JAR's signed-in browser creates a temporary chat with the character, sends probe messages to trigger its lorebook entries, captures the prompt and deletes the chat. This acts on the JanitorAI account signed into JAR, so use a throwaway account (see above). It is unavailable when the creator does not allow proxies. Entries only appear when one of their keywords is in the trigger message, so the confirmation has a **Your words** box for names, places or other likely keywords, and an **Also include** list of what else JAR puts in that message (card, site description, scenario, first messages, lorebook names, JAR's saved default trigger text; all on by default, like JAR's own capture panel).
  2. **Rebuild with JAR's LLM**: JAR sends the captured text and the card to the extraction LLM set in JAR's **⚙ Settings**, which rebuilds entries with trigger keywords. This uses that service's quota or credit.

  Once JAR has captured anything, a note above the list explains the limits: capture only records entries whose keywords appeared, keywords are guessed by the LLM, and JAR combines several closed lorebooks into one rebuilt book. Until you rebuild, it is shown as a warning, with its own **Rebuild with JAR's LLM…** button, because nothing from the closed lorebook can be imported yet.

  A rebuilt lorebook is not attached automatically. It appears in a highlighted box at the top of the Lorebooks section, and after you import the card, **Import and attach to <character>** adds it in one click. Before the card is imported, **Import card and attach** does both: it imports the previewed card, then its public lorebooks and the rebuilt one, all attached to it.

  Imported the character earlier? **Already have this character in Lumiverse? Attach lorebooks to it** looks up your library by the character's name and preselects an exact match; **Find** searches for another one. Books you import then attach to that character. Choosing a character never imports anything by itself.

A closed lorebook is one its creator chose not to share, and automated capture may break JanitorAI's terms. Capture only records entries that the probe actually triggered, so a large closed lorebook can come back incomplete. Rebuilt keywords are inferred by the LLM: review them, and edit very general ones in Lumiverse's World Info after import.

Capture and rebuild can take longer than Lumiverse's 30-second connection limit. JAR keeps working after the connection closes, so the importer checks the character's JAR record every few seconds for up to 10 minutes. **Stop waiting** stops checking; JAR may still finish, and **Check JAR for lorebooks** reads the result later.

## Phone or tablet without JAR

Use **Help and import guide → Phone or tablet · card file**. The guide links to [JannyAI](https://jannyai.com/) and [DataCat](https://datacat.run/) as character-card download alternatives, depending on availability and the creator's settings. Download an actual card, then return to **Import card file**.

For lorebooks, including closed ones, the guide also links to [Sucker](https://sucker.severian.dev/). It works as a proxy in JanitorAI's API settings: chat with the character, and it extracts the card and the lorebook entries your messages trigger. Follow the instructions on its page; it only works when the creator allows proxies. Import a lorebook file from Lumiverse's World Info panel and attach it to the character there.

These sites are not presented as a way to retrieve your private chat history. For a conversation, use a JAR JSON or compatible SillyTavern JSONL export you already have, or use JAR on a computer.

## If something does not load

- **JAR cannot connect:** choose **Check JAR connection**. Open `start.bat` in the extracted JAR folder on Windows, or run `npm start`, and keep its console open on the Lumiverse server computer. Match the port printed there using **Change JAR address**. **JAR won't connect?** opens automatically after a failed connection check.
- **JAR runs on a different computer or outside Lumiverse's Docker container:** loopback points to the Lumiverse server/container. Running JAR on your browsing device does not make it reachable there. Run both in a supported local environment or import card/history files.
- **JAR is running but Chromium is missing:** run `npx.cmd playwright install chromium` in the extracted JAR folder on Windows (`npx playwright install chromium` on macOS/Linux), restart JAR, then sign in through its **Log in** button.
- **Sign-in expired:** use JAR's **log in** browser, then retry in Lumiverse.
- **JAR's browser is busy:** let its current operation finish before retrying.
- **A chat works in JAR but not here:** download it from JAR as JSON or SillyTavern JSONL, then choose **Chat history → History file**. Lumiverse limits each proxied request to 30 seconds.
- **A lorebook step fails:** keep JAR signed in and idle, and check its extraction LLM settings before rebuilding. If the creator does not allow proxies, only public lorebooks are available.
- **The card is incomplete:** the creator hides the definition, so the link preview has only public details. Use **Capture hidden card with JAR…** (see below), a completed exported card, or an existing character for the conversation.
- **The save result is interrupted:** check the destination character's chats or your library before explicitly retrying. A native save can finish even if its response was lost.

## What is saved

Cards use Lumiverse's normal importer and retain supported definition fields, greetings (alternate greetings that repeat the first message with JanitorAI's "created by … on janitorai.com" line, are dropped; placeholder greetings such as `.` are kept), instructions, tags, card extensions and embedded character lorebooks. PNG imports preserve portraits. Public creator names and JanitorAI creator IDs supplied by JAR are retained as card attribution, including the creator's public profile link when available. Some JAR cards also carry a public SoundCloud track ID, retained as display metadata for compatible interfaces such as Janiverse.

Each history import creates **one new normal Lumiverse chat**. It retains message text and macros, speaker names, alternate replies, the selected reply, and available timestamps. Historic persona names do not automatically bind a Lumiverse persona. Native timestamps have second precision. JAR's own JSONL exporter may already trim text or group alternatives; the bridge preserves the export it receives. Raw JAR JSON imports preserve literal text locally.

Each lorebook import creates **one new World Info book** with the reviewed entries. Attaching it adds the book to the character's existing lorebooks without removing any.

Existing chats stay separate. Lumiverse's usual API, prompts, presets and other settings govern continuation. Files and serialized imports are limited to 10 MiB; malformed messages are rejected rather than silently skipped. Repeated/uncertain imports are guarded within the current page session.

## Permissions and privacy

- **CORS proxy:** accesses the selected local JAR service. Link previews can ask JAR to use its signed-in browser to retrieve the selected character or conversation. Supported service addresses are HTTP loopback (`127.0.0.1`, `localhost` or `[::1]`). Use a trusted JAR service; Lumiverse's proxy follows redirects.
- **Characters:** saves the explicitly reviewed card through Lumiverse's native importer.
- **Chats:** saves the reviewed conversation for the character you explicitly choose.
- **World Books:** saves lorebooks and attaches them to the character you just imported (public ones automatically with the card, rebuilt ones when you choose).

Opening the assistant or Help does not connect, request access or import anything. The first preview of a link may create/link a local JAR record (later previews reuse it), but do not send chat messages or create native Lumiverse chats/cards. Lorebook capture and rebuild run only after you confirm them for the previewed character: capture sends probe messages through JAR's JanitorAI session, and rebuild sends the captured text to the LLM configured in JAR. The bridge never runs either automatically, never reads JAR settings, credentials or session files, and never passes captured prompts to the browser, only the lorebook entries. Only supported HTTPS JanitorAI character/chat URLs are accepted; tracking parameters are removed.

Backend replies are limited to the originating account and browser document. Selected chat/character identities are checked before returning history. File previews are parsed locally; raw settings, arbitrary chat metadata and unrelated profile data are not copied into native chats. Operator installations verify the requesting account through Lumiverse's native host before accessing the shared JAR session. Personal installations additionally require an account/installation pin, provisioned only after a short-lived random challenge is acknowledged by the exact requesting owner document through Lumiverse's native session routing; unrelated users, expired proofs and cancelled requests cannot provision it. Existing personal bindings are checked without replacing them.

## Development

Install [Bun](https://bun.sh/), then run:

```sh
bun test
bun run build
```

There are no runtime package dependencies. Source and prebuilt `dist/` bundles are included. The portable tests use synthetic data and mocked host APIs; they do not need a signed-in JAR or Lumiverse server. The importer has also been checked against JAR 0.4 and Lumiverse 1.2.5. Unfamiliar API responses fail with an error instead of creating an empty card/chat.
