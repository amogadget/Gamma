# Gamma privacy policy

_Last updated: 2026-09-16._

Gamma is an open-source PDF annotation and note-taking application
([github.com/tim4431/Gamma](https://github.com/tim4431/Gamma)). This
policy covers the Gamma desktop app (Windows, macOS, including the
Microsoft Store edition "Gamma PDF"), the self-hosted Gamma server, and
the Gamma Connector browser extension. It is published by the developer of
Gamma, referred to below as "we".

## The short version

- **We collect nothing.** Gamma has no telemetry, analytics, crash
  reporting, advertising, or accounts hosted by us. No usage data is sent
  to the developer.
- **Your data stays where you put it.** Everything you create in Gamma
  (PDFs, highlights, notes, chats, settings) is stored in a data directory
  on your own computer, or on a server that you or your organisation run.
- **Network requests only happen for features you use**, and go to the
  services listed below, never to us.

## What Gamma stores, and where

The desktop app runs a local Gamma server on your machine. All of its
state lives in the app's data directory: your PDFs, highlights and notes,
AI chat history, preferences, and the credentials you enter for optional
services. Uninstalling the app or deleting that directory removes it. For
the Microsoft Store edition the default data location is inside the
package's virtualised AppData folder, and the launcher lets you move it
elsewhere; uninstalling the Store app deletes the default location.

If you connect the app to a remote Gamma server (for example one you run
on a home NAS), your data is stored on that server and governed by whoever
operates it. Gamma servers use their own local accounts; passwords are
stored as salted hashes. A server never contacts the developer.

## Network connections Gamma makes

Gamma talks to third-party services only when you use the feature that
needs them. What is sent is limited to what the feature requires:

- **Paper metadata and PDF lookup**: when you add a paper or fetch its
  metadata, identifiers or titles are sent to public scholarly services
  (arXiv, doi.org / Crossref / DataCite, Unpaywall, Open Library, Google
  Books) and the publisher's site that hosts the PDF.
- **Link previews**: pasting a link fetches that page's title and icon
  (icon lookups use DuckDuckGo's favicon service).
- **AI features**: entirely optional and off until you add a provider in
  Settings. When you use them, the text you select or ask about, and any
  document excerpts needed to answer, are sent to the provider you
  configured (for example Anthropic, OpenAI, or a server you host) using
  your own API key or account. Their privacy policies apply to that data.
  Your keys are stored only in your Gamma data directory.
- **External assistants (MCP), what the assistant reads**: when you approve a
  workspace in Gamma's browser sign-in flow, or create a manual token and give
  it to an MCP client, that client can read the workspace's pages, notes,
  highlights, metadata, and extracted PDF text. Retrieved content includes
  titles and page IDs returned by the optional paper picker before you select
  a paper. Selecting **Use this paper** sends its title and Gamma URL
  (including the page and workspace IDs) as a message in your assistant's
  conversation, along with any question you enter in the picker. The picker
  itself loads no third-party scripts and receives no connection tokens.
  Content is handled by the assistant and its provider under their policies.
  This does not send data to the Gamma developer or require configuring an AI
  provider inside Gamma.
- **External assistants (MCP), what Gamma stores**: only a hash of the
  connection token. Browser sign-in also stores client registration metadata
  and temporary authorization/consent records; authorization codes are stored
  as hashes and expire after two minutes. Tokens expire after 90 days and can
  be revoked in Settings → AI → External assistants.
- **Update checks** (desktop app, non-Store installs): the app asks GitHub
  Releases for the latest version. The Microsoft Store edition never does
  this; the Store delivers updates.
- **Browser extension**: the Gamma Connector talks only to the Gamma
  server you configured, sending the address of the page or PDF you chose
  to save.

Each of these services receives your IP address as part of the request,
as any web request does. Gamma adds no identifiers of its own.

## Sharing

Gamma can create share links for pages. Anyone with a link can read (or,
if you allow it, edit) that page on your server. Sharing is under your
control and can be revoked at any time from the app.

## Children

Gamma is a general-purpose productivity tool and does not knowingly
collect any information from anyone, including children.

## Changes

This policy is maintained in the Gamma repository. Changes are visible in
its version history.

## Contact

Questions about this policy can be raised on the project's issue tracker:
[github.com/tim4431/Gamma/issues](https://github.com/tim4431/Gamma/issues).
