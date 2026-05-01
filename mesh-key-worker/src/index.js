export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST' || url.pathname !== '/v1/key') {
      return new Response('Not Found', { status: 404 });
    }

    const resp = await fetch(
      `https://api.tailscale.com/api/v2/tailnet/${env.TS_TAILNET}/keys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          capabilities: {
            devices: {
              create: { reusable: false, ephemeral: true, preauthorized: true },
            },
          },
          expirySeconds: 86400,
          description: 'Buzz Mesh auto-issued key',
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Tailscale API error:', resp.status, text);
      return new Response('Failed to issue key', { status: 502 });
    }

    const data = await resp.json();
    return Response.json({ key: data.key });
  },
};
