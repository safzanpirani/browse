// Host-rewriting loopback proxy for tunnelled Browser Control relays.
// A relay rejects any request whose Host header port differs from its own port
// ("Invalid Host header port"), so an ssh -L on a different local port fails. For each
// relay port P this listens on 127.0.0.1:(P+LISTEN_OFFSET), forwards to the ssh tunnel
// on 127.0.0.1:(P+TUNNEL_OFFSET), and rewrites Host to 127.0.0.1:P (HTTP and WebSocket).
//
//   node relay-proxy.mjs 19989 19990 ...   [LISTEN_OFFSET=10000 TUNNEL_OFFSET=20000]
import http from "node:http"
import net from "node:net"

const listenOffset = Number(process.env.LISTEN_OFFSET ?? 10000)
const tunnelOffset = Number(process.env.TUNNEL_OFFSET ?? 20000)
const ports = process.argv.slice(2).map(Number)
if (ports.length === 0 || ports.some((p) => !Number.isInteger(p))) {
  console.error("usage: relay-proxy.mjs <relay-port>...")
  process.exit(2)
}

for (const relay of ports) {
  const target = relay + tunnelOffset
  const host = `127.0.0.1:${relay}`

  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: { ...req.headers, host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
      res.end(`relay ${relay} unreachable through tunnel: ${err.code ?? err.message}\n`)
    })
    req.pipe(upstream)
  })

  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(target, "127.0.0.1", () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (const [k, v] of Object.entries({ ...req.headers, host })) {
        for (const value of Array.isArray(v) ? v : [v]) raw += `${k}: ${value}\r\n`
      }
      upstream.write(raw + "\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = () => { upstream.destroy(); socket.destroy() }
    upstream.on("error", close)
    socket.on("error", close)
  })

  server.on("error", (err) => {
    console.error(`relay ${relay}: cannot listen on ${relay + listenOffset}: ${err.code ?? err.message}`)
    process.exitCode = 1
  })
  server.listen(relay + listenOffset, "127.0.0.1")
}
