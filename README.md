# JAR Bridge

Import character cards and old conversations into Lumiverse with an optional walkthrough, local previews, and a clear destination picker. JAR Bridge works on its own or alongside [Janiverse](https://github.com/lunchberrymail-cmyk/Janiverse).

This is an unofficial bridge for [alpha-omicron/JAR](https://github.com/alpha-omicron/JAR). It is not affiliated with JanitorAI or JAR. JAR is a separate application; installing this extension does not install or start it.

## What you can import

| Source | What it brings | Needs JAR running? |
| --- | --- | --- |
| JanitorAI character link | The available character definition and portrait | Yes |
| JanitorAI conversation link | The selected conversation, plus its character card when available | Yes |
| PNG, JSON or CHARX character card | Character definition and supported card data; portraits when included | No |
| JAR JSON or SillyTavern JSONL history file | Messages and alternate replies for a character you choose | No |

A character card and a conversation are different things. Bring both to resume an old chat, or import only the history if its character is already in your Lumiverse library. A portrait or screenshot by itself is not a character card.

## Install

Requires **Lumiverse 1.2.5 or later**. Install the repository through Lumiverse's Extensions window using:

```text
https://github.com/lunchberrymail-cmyk/JAR-Bridge
```

Choose a **personal/user-scoped installation** for the account that will access JAR. On the first explicit connection or link preview, the extension confirms that its requesting window belongs to that personal installation and remembers the account automatically. No terminal command or manual account setup is required. An existing account/installation binding cannot be replaced by another account. Operator-wide installations cannot create this binding; install the extension personally for live JAR access. File imports can be used without a running JAR.

Open **JAR Import** in Lumiverse's sidebar, or use Janiverse's import banner. The assistant opens with the import controls. **Help and import guide** is optional, and **Back to importer** preserves your current selection and destination. Closing and reopening the assistant preserves progress during the page session.

## Start JAR once on your computer

**JAR needs a Windows, macOS or Linux computer with a graphical desktop. It does not run directly on phones or tablets; Termux is unsupported.** Run it on the computer hosting your Lumiverse server.

1. Follow the [official JAR setup instructions](https://github.com/alpha-omicron/JAR). Extract the download completely into a folder before running it.
2. Start JAR and keep its console open. On Windows, use `start.bat` when supplied. If the launcher is missing or fails, see the manual commands below.
3. Open the local address printed by JAR, usually `http://127.0.0.1:4577`. Startup has worked when JAR's page and its character URL field appear.
4. In JAR, choose **log in**. Sign into JanitorAI in the separate browser it opens. Being signed into JanitorAI in your usual browser is not enough.
5. Return to Lumiverse. You can paste links and finish the transfer here; you do not need to prepare or link them in JAR's window first.

For manual Windows startup, install Node.js LTS, open a terminal in the extracted JAR folder containing `package.json`, then run these commands in order:

```powershell
npm.cmd install
npm.cmd start
```

If JAR reports a missing Chromium executable, stop JAR, run `npx.cmd playwright install chromium`, then start it again. The `.cmd` commands work in PowerShell without changing its execution policy. On macOS or Linux, follow JAR's requirements and use `npm start`.

If you view Lumiverse on a phone while JAR is already running on the server computer, you can still paste links in this importer. A browser link to `127.0.0.1` opens the device you are currently viewing, so open JAR's own interface on the host computer.

## Import a card and chat

1. In **JanitorAI link**, paste a `https://janitorai.com/characters/…` or `/chats/…` link and choose **Preview link**.
2. Review the character and choose **Import to Lumiverse** if you need it in your library.
3. Choose **Next: import chat history**. For a conversation link, the loaded messages follow automatically. If the character is already here, **Use an existing character for this chat** skips another card import.
4. Review the messages, choose the destination character, then choose **Import chat → Continue chat**.

For history only, open **Chat history → From JAR**, paste the conversation URL into **JanitorAI conversation link**, and choose **Load chat**. Choose a Lumiverse character before importing. You do not need to connect a saved-card catalog first.

For files, choose **Import card file** for PNG/JSON/CHARX cards or **Chat history → History file** for JAR JSON/SillyTavern JSONL. You can use either file route without JAR running. A JAR JSON history export supplies messages; import the character card separately if needed.

**Cards already saved in JAR** and **Saved conversations in JAR** are optional, initially collapsed sections for browsing JAR's existing records. The normal address is filled in; expand **Change JAR address** only for a different local port.

## Phone or tablet without JAR

Use **Help and import guide → Phone or tablet · card file**. The guide links to [JannyAI](https://jannyai.com/) and [DataCat](https://datacat.run/) as character-card download alternatives, depending on availability and the creator's settings. Download an actual card, then return to **Import card file**.

These sites are not presented as a way to retrieve your private chat history. For a conversation, use a JAR JSON or compatible SillyTavern JSONL export you already have, or use JAR on a computer.

## If something does not load

- **JAR cannot connect:** keep JAR running on the Lumiverse server computer and check its local address.
- **Sign-in expired:** use JAR's **log in** browser, then retry in Lumiverse.
- **JAR's browser is busy:** let its current operation finish before retrying.
- **A chat works in JAR but not here:** download it from JAR as JSON or SillyTavern JSONL, then choose **Chat history → History file**. Lumiverse limits each proxied request to 30 seconds.
- **The card is incomplete:** a saved/link record can contain only a name. Use a completed exported card or choose an existing character for the conversation. Hidden-card recovery stays a separate, explicit action in JAR and may send probes/create chats.
- **The save result is interrupted:** check the destination character's chats or your library before explicitly retrying. A native save can finish even if its response was lost.

## What is saved

Cards use Lumiverse's normal importer and retain supported definition fields, greetings, instructions, tags, card extensions and embedded character lorebooks. PNG imports preserve portraits. Some JAR cards also carry a public SoundCloud track ID, retained as display metadata for compatible interfaces such as Janiverse.

Each history import creates **one new normal Lumiverse chat**. It retains message text and macros, speaker names, alternate replies, the selected reply, and available timestamps. Historic persona names do not automatically bind a Lumiverse persona. Native timestamps have second precision. JAR's own JSONL exporter may already trim text or group alternatives; the bridge preserves the export it receives. Raw JAR JSON imports preserve literal text locally.

Existing chats stay separate. Lumiverse's usual API, prompts, presets and other settings govern continuation. Standalone lorebook import is not included. Files and serialized imports are limited to 10 MiB; malformed messages are rejected rather than silently skipped. Repeated/uncertain imports are guarded within the current page session.

## Permissions and privacy

- **CORS proxy:** accesses the selected local JAR service. Link previews can ask JAR to use its signed-in browser to retrieve the selected character or conversation. Supported service addresses are HTTP loopback (`127.0.0.1`, `localhost` or `[::1]`). Use a trusted JAR service; Lumiverse's proxy follows redirects.
- **Characters:** saves the explicitly reviewed card through Lumiverse's native importer.
- **Chats:** saves the reviewed conversation for the character you explicitly choose.

Opening the assistant or Help does not connect, request access or import anything. Link previews may create/link a local JAR record, but do not send chat messages or create native Lumiverse chats/cards. The bridge does not read JAR settings, credentials or session files, run extraction probes, or upload captures to an external service. Only supported HTTPS JanitorAI character/chat URLs are accepted; tracking parameters are removed.

Backend replies are limited to the originating account and browser document. Selected chat/character identities are checked before returning history. File previews are parsed locally; raw settings, arbitrary chat metadata and unrelated profile data are not copied into native chats. An account/installation pin protects access to the signed-in JAR archive. A fresh personal installation provisions it only after a short-lived random challenge is acknowledged by the exact requesting owner document through Lumiverse's native session routing; unrelated users, expired proofs and cancelled requests cannot provision it. Existing bindings are checked without replacing them.

## Development

Install [Bun](https://bun.sh/), then run:

```sh
bun test
bun run build
```

There are no runtime package dependencies. Source and prebuilt `dist/` bundles are included. The portable tests use synthetic data and mocked host APIs; they do not need a signed-in JAR or Lumiverse server. The importer has also been checked against JAR 0.4 and Lumiverse 1.2.5. Unfamiliar API responses fail with an error instead of creating an empty card/chat.
