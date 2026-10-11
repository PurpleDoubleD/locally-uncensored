# Parallel Search MCP

In the desktop app, open **Settings → MCP Servers**, click **Add Parallel Search**,
then click **Connect** on its server entry. Install Node.js if `npx` is not already
available. The first connection downloads the pinned `mcp-remote` bridge; allow
it to finish, then retry Connect if the download exceeded the connection timeout.
External MCP servers require the desktop app, rather than browser dev mode.

The preset adds `parallel_web_search` and `parallel_web_fetch` through LU's existing
MCP tool registry. It leaves the built-in web tools and saved servers in place.
The normal external-tool permission settings apply. Disconnect or remove the
entry in the same panel when you no longer need it.

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides
free search in Fast mode and page fetching without an account or API key, with
lower rate limits for anonymous use. It needs an internet connection and sends
search queries and fetched URLs to Parallel, so this optional service is not offline.

The preset runs `npx -y mcp-remote@0.14.3 https://search.parallel.ai/mcp --transport
http-only --header User-Agent:locally-uncensored`. The bridge connects using
Streamable HTTP; `parallel_` is a local tool namespace to avoid collisions with
LU's built-in tools.
