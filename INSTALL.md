# Install RackDeck

RackDeck runs in Docker. You can install it from CasaOS, from a terminal, or from the source
code. All three paths run the same application.

## Before you start

- A Linux machine, mini PC, Raspberry Pi, or a CasaOS host.
- Docker with Docker Compose v2. CasaOS already includes both.
- A trusted network. The main dashboard has no login, so do not expose it directly to the
  internet.

## Choose a path

| Your setup                    | Use this                                              |
| ----------------------------- | ----------------------------------------------------- |
| CasaOS                        | Import `casaos-compose.yaml` from the latest release. |
| Docker on a Linux host        | Run the one-line installer.                           |
| A server you want to pin      | Download `install.sh` and choose an exact version.    |
| Development or a custom build | Use Docker Compose from the source checkout.          |

## CasaOS: import the compose file

1. Open the [latest release](https://github.com/Kaquely/RackDeck/releases/latest).
2. Download `casaos-compose.yaml`.
3. In CasaOS, open **Import → Docker Compose**.
4. Upload the file and confirm the install.

CasaOS creates the data volume and starts RackDeck. No `.env` file is needed for this path.

For the **Docker CLI** tab in the same dialog, download `docker-run.txt` from the release and
paste its contents.

## One command

On a Linux host, this downloads the latest release, checks the installer, and runs it:

```bash
curl -fsSL https://github.com/Kaquely/RackDeck/releases/latest/download/get.sh | sudo sh
```

`sudo` is needed because the installer writes the deployment to `/opt/homelabmd` or to the
CasaOS app folder. The script detects CasaOS automatically.

The bootstrap downloads `install.sh` and checks its fingerprint against the published
`SHA256SUMS` file before running it. It does not change the host by itself; the installer does
the actual work.

For a peer node, run it without `sudo` and choose a folder you own:

```bash
curl -fsSL https://github.com/Kaquely/RackDeck/releases/latest/download/get.sh \
  | sh -s -- --role peer --prefix "$HOME/homelabmd"
```

A peer is another RackDeck instance that the main node reads. It needs the same token you enter
in the main dashboard.

## Pinned version

Use this path when you want to know exactly which version is running. Download the installer
first, read it, then run it with a version you choose:

```bash
curl -fsSLO "https://github.com/Kaquely/RackDeck/releases/download/v<version>/install.sh"
less install.sh
```

On a CasaOS host:

```bash
sudo bash install.sh install --casaos --version <version>
```

On a normal Linux host:

```bash
sudo bash install.sh install --version <version> --prefix /opt/homelabmd
```

On a peer:

```bash
bash install.sh install --role peer --prefix "$HOME/homelabmd" --version <version>
```

Replace `<version>` with a real release such as `1.0.0`. Do not use `latest`: RackDeck is
designed to run an exact version, so an update is always a deliberate action.

## Docker Compose from source

Use this path if you want to build the image yourself or change the source.

```bash
docker volume create homelabmd-data
cp .env.example .env
# Set HOMELABMD_IMAGE_TAG to an exact release version, for example 1.0.0.
docker compose -f infra/compose.yaml up -d
```

The image is published at `ghcr.io/kaquely/rackdeck`. The package must be public for Docker to
pull it without a login.

## After the install

The installer creates a small `homelabmd` command that manages the deployment:

```bash
homelabmd status          # show what is running
homelabmd update --check  # ask whether a newer release exists
homelabmd update          # move to the newest release
homelabmd rollback        # go back to the previous deployment
```

The application never updates itself. An update is always a command you run.

## Troubleshooting

| Problem                        | What to try                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `Permission denied`            | Run the command with `sudo`, or use `--prefix` with a folder you own.                          |
| The container is unhealthy     | Run `docker compose logs --tail=50 homelabmd` and read the first error.                        |
| Docker cannot pull the image   | The GHCR package must be public. Until then, log in with `docker login ghcr.io`.               |
| Port 3000 is already in use    | Set `HOMELABMD_PUBLISH=3001` in `.env`, then restart the container.                            |
| CasaOS import fails            | Download `casaos-compose.yaml` from the latest release, not from the source tree.              |
| A peer cannot connect          | Check the address, the token, and the firewall. The peer must be reachable from the main node. |
| The dashboard shows no history | Wait a few seconds. The default history is about five minutes.                                 |

## Security notes

- The main dashboard has no login. Keep it on a trusted LAN, or put it behind a reverse proxy
  that authenticates users.
- A peer node requires a long random token. Treat that token like a password.
- RackDeck never mounts the Docker socket and never changes the systems it observes.
- Pi-hole credentials stay in the environment. They are never logged or returned by the API.

If you are unsure which path to use, start with the CasaOS import or the one-line installer.
Both are the same deployment underneath.
