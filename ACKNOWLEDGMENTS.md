# Acknowledgments

agent-socket builds on the work of others. With thanks to:

## PartyServer

The relay's Durable-Object layer is built on top of [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) by Baldur Bjarnason and the PartyKit team. PartyServer provides the `Server` base class that handles per-connection lifecycle, message routing, and the in-memory connection registry the relay relies on.

License: ISC.

## Cloudflare Workers + Durable Objects

The whole relay model — a tiny stateful router that lives at the network edge — is only possible because of Cloudflare Workers + Durable Objects. The architecture is shaped by what they make easy.

## Inspiration

The "paste a URL into your AI chat and the AI can drive your app" interaction pattern was independently arrived at by several people exploring AI tool use. We didn't invent the idea — we shipped one specific implementation of it that doesn't require MCP.

## Contributors

See the [contributors page](https://github.com/teenybase/agentsocket/graphs/contributors) on GitHub.
