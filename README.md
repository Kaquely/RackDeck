# RackDeck

RackDeck is a read-only dashboard for your homelab. It puts the health and activity of your
machines, your Pi-hole, and your other RackDeck nodes on one page, with tabs, widgets, and live
charts that you can arrange yourself.

A homelab is a small server setup at home: a rack, a mini PC, a Raspberry Pi, or a few
containers running on one machine. RackDeck is for people who want to see what is happening
there without opening a separate tool for every service.

> The container name and environment variables use the `homelabmd` identifier for compatibility.

## What you can see

| Area               | What RackDeck shows                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| This machine       | CPU usage and load, memory, uptime, network traffic, storage usage, process count, disks, and network interfaces.                       |
| Pi-hole (optional) | DNS queries, blocked percentage, cached and forwarded queries, unique clients and domains, and the top clients, domains, and upstreams. |
| Other nodes        | Another RackDeck node on your network. Add it once and its readings appear next to the local ones.                                      |
| Your layout        | Tabs and widgets. Choose line, bar, gauge, table, or bullet charts. The layout is saved, so it is still there after a restart.          |

## Why "read-only" matters

RackDeck only reads. It never restarts a container, changes a setting, or writes to a machine it
watches. It does not mount the Docker socket. That makes it safe to run next to the systems it
monitors: a bug in the dashboard cannot break your homelab.

The only things RackDeck writes are its own dashboard layout and its list of peer nodes, inside
its own data folder.

## How it works

```text
Your browser
    |
    v
RackDeck (main node)
    |-- reads the machine it runs on
    |-- reads Pi-hole, when configured
    `-- reads other RackDeck nodes, when configured
```

RackDeck keeps no database. It stores the dashboard layout and the peer list in two small JSON
files, so a backup is a file copy.

## Quick start

Pick the path that matches your setup:

| If you use                    | Start here                                            |
| ----------------------------- | ----------------------------------------------------- |
| CasaOS                        | Import `casaos-compose.yaml` from the latest release. |
| Docker on a Linux host        | Run the one-line installer below.                     |
| Docker Compose or development | Use the compose file or the source checkout.          |

```bash
curl -fsSL https://github.com/Kaquely/RackDeck/releases/latest/download/get.sh | sudo sh
```

The installer downloads the latest release, checks it, starts RackDeck, and waits until it is
healthy. For a peer node, use:

```bash
curl -fsSL https://github.com/Kaquely/RackDeck/releases/latest/download/get.sh \
  | sh -s -- --role peer --prefix "$HOME/homelabmd"
```

See [INSTALL.md](INSTALL.md) for the CasaOS import steps, the exact-version install, Docker
Compose, and troubleshooting.

## Configuration

Most people do not need to change anything. RackDeck listens on port 3000 and keeps about five
minutes of history by default.

Copy `.env.example` to `.env` when you want to change the port, the sampling interval, the
Pi-hole connection, or peer settings. Every setting is documented there.

## Security

- The main dashboard has no login. Keep it on a trusted network, or put it behind a reverse
  proxy that asks for a login.
- A peer node requires a long random token. The main node sends that token when it reads the
  peer.
- RackDeck never mounts the Docker socket and never changes the systems it observes.
- The Pi-hole password is never written to logs or returned by the API.

## Development

```bash
npm install
npm run dev
```

The dashboard is then available at `http://localhost:3000`. Run `npm run verify` before opening
a pull request. It runs formatting, linting, type checks, tests, the production build, and the
security audit.

The container build and the installer are documented in [INSTALL.md](INSTALL.md).

## Project status

RackDeck 1.0.0 is the first public release. The install path and the read-only behavior are
stable. Future releases may still add API fields, layout options, and integrations.

## License

Apache-2.0. See [LICENSE](LICENSE).
