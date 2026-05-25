![Alby Hub Logo](https://raw.githubusercontent.com/getAlby/hub/refs/heads/master/doc/logo.svg)

\## \[Alby Hub\](https://albyhub.com) - Your Own Center for Internet Money

Alby Hub allows you to control your Lightning node or wallet from any other application that supports \[NWC\](https://nwc.dev/).
Connect apps like \[Damus\](https://damus.io/) or \[Amethyst\](https://linktr.ee/amethyst.social) to your node. There are many more available on https://nwc.dev/.

The application can run in two modes:

\- Desktop (Wails app): Mac (arm64), Windows (amd64), Linux (amd64)
\- HTTP (Web app): Docker, Linux (amd64), Mac (arm64)

Ideally the app runs 24/7 (on a node, VPS or always-online desktop/laptop machine) so it can be connected to a lightning address and receive online payments.

\## Run on Alby Cloud

Visit \[albyhub.com\](https://albyhub.com) to learn more and get started and get Alby Hub running in minutes.

\## Self Hosted

Go to the \[Deploy it yourself\](#deploy-it-yourself) section below.

\## Supported Backends

By default Alby Hub uses the embedded LDK based lightning node. Optionally it can be configured to use an external node:

\- LND
\- Phoenixd
\- Cashu
\- CLN
\- want more? please open an issue.

\## Development

\### Required Software

\- Go
\- Node
\- NPM
\- Yarn

\### Environment setup

 $ cp .env.example .env
 # edit the config for your needs (Read further down for all the available env options)
 $ vim .env

\### Server (HTTP mode)

1\. Create a Lightning Polar setup with two LND nodes and uncomment the Polar LND section in your \`.env\` file.

2\. Compile the frontend or run \`touch frontend/dist/tmp\` to ensure there are embeddable files available.

3\. \`go run cmd/http/main.go\`

\### React Frontend (HTTP mode)

Go to \`/frontend\`

1\. \`yarn install\`
2\. \`yarn dev:http\`

\### HTTP Production build

 $ yarn build:http

If you plan to run Alby Hub on a subpath behind a reverse proxy, you can do:

 $ BASE\_PATH="/hub" yarn build:http

\### Wails (Backend + Frontend)

\_Make sure to have \[wails\](https://wails.io/docs/gettingstarted/installation) installed and all platform-specific dependencies installed (see wails doctor)\_

 $ wails dev -tags "wails"

\_If you get a blank screen, try running in your normal terminal (outside of vscode, and make sure HTTP frontend is not running)\_

\#### Wails Production build

 $ wails build -tags "wails"

\### Build and run locally (HTTP mode)

 $ mkdir tmp
 $ go build -o main cmd/http/main.go
 $ cp main tmp
 $ cp .env tmp
 $ cd tmp
 $ ./main

\### Run dockerfile locally (HTTP mode)

 $ docker build . -t nwc-local --progress=plain
 $ docker run -v $(pwd)/.data/docker:/data -e WORK\_DIR='/data' -p 8080:8080 nwc-local

\### Debugging

In vscode open \[cmd/http/main.go\](cmd/http/main.go) and then press F5. You can set breakpoints in the Alby Hub code and third party modules

\### Testing

 $ go test ./...

\#### Test matching regular expression

 $ go test ./... -run TestHandleGetInfoEvent

\#### Testing with PostgreSQL

By default, sqlite is used for testing. It is also possible to run the tests with PostgreSQL.

The tests use \[pgtestdb\](https://github.com/peterldowns/pgtestdb) to set up a temporary PostgreSQL database, which requires a running PostgreSQL server. Follow your OS instructions to install PostgreSQL, or use the official \[Docker image\](https://hub.docker.com/\_/postgres).

See the \[docker compose file\](./tests/db/postgres/docker-compose.yml) for an easy way to get started.

When PostgreSQL is installed and running, set the \`TEST\_DATABASE\_URI\` environment variable to the PostgreSQL connection string. For example:

 $ export TEST\_DATABASE\_URI="postgresql://user:password@localhost:5432/postgres"

Note that the PostgreSQL user account must be granted appropriate permissions to create new databases. When the tests complete, the temporary database will be removed.

\*\*Do not\*\* use a production database. It is preferable to launch a dedicated PostgreSQL instance for testing purposes.

\#### Mocking

We use \[testify/mock\](https://github.com/stretchr/testify) to facilitate mocking in tests. Instead of writing mocks manually, we generate them using \[vektra/mockery\](https://github.com/vektra/mockery). To regenerate them, \[install mockery\](https://vektra.github.io/mockery/latest/installation) and run it in the project's root directory:

 $ mockery

Mockery loads its configuration from the .mockery.yaml file in the root directory of this project. To add mocks for new interfaces, add them to the configuration file and run mockery.

\### Profiling

The application supports both the Go pprof library and the DataDog profiler.

\#### Go pprof

To enable Go pprof, set the \`GO\_PROFILER\_ADDR\` environment variable to the address you want the profiler to be available on (e.g. \`localhost:6060\`).

Now, you should be able to access the pprof web interface at \`http://localhost:6060/debug/pprof\`.

You can use the \`go tool pprof\` command to collect and inspect the profiling data. For example, to profile the application for 30 seconds and then open the pprof web UI, run:

\`\`\`sh
go tool pprof -http=localhost:8081 -seconds=30 http://localhost:6060/debug/pprof/profile
\`\`\`

For more information on the Go pprof library, see the \[official documentation\](https://pkg.go.dev/net/http/pprof).

\### Versioning

 $ go run -ldflags="-X 'github.com/getAlby/hub/version.Tag=v0.6.0'" cmd/http/main.go

\## Optional configuration parameters

The following configuration options can be set as environment variables or in a .env file

\- \`RELAY\`: default: "wss://relay.getalby.com,wss://relay2.getalby.com" (supports multiple separated by commas)
\- \`DATABASE\_URI\`: A sqlite filename or postgres URL. Default is SQLite DB \`nwc.db\` without a path, which will be put in the user home directory: $XDG\_DATA\_HOME/albyhub/nwc.db
\- \`PORT\`: The port on which the app should listen on (default: 8080)
\- \`WORK\_DIR\`: Directory to store NWC data files. Default: $XDG\_DATA\_HOME/albyhub
\- \`LOG\_LEVEL\`: Log level for the main application. Higher is more verbose. Default: 4 (info)
\- \`AUTO\_UNLOCK\_PASSWORD\`: Provide unlock password to auto-unlock Alby Hub on startup (e.g. after a machine restart). Unlock password still be required to access the interface.
\- \`BOLTZ\_API\`: The api which provides auto swaps functionality. Default: "https://api.boltz.exchange"
\- \`NETWORK\`: On-chain network used for the node. Default: "bitcoin"
\- \`REBALANCE\_SERVICE\_URL\`: service url for rebalancing existing channels.

\### Boltz Regtest Setup

There is a boltz regtest fork with mempool service and alby-specific instructions \[here\](https://github.com/rolznz/boltz-regtest/tree/alby-hub?tab=readme-ov-file#your-first-swap)

Make sure to update your RPC password below, and change your work directory each time you restart boltz (it is ephemeral):

 WORK\_DIR=.data/boltz-regtest-1
 LDK\_BITCOIND\_RPC\_HOST="127.0.0.1"
 LDK\_BITCOIND\_RPC\_PORT="18443"
 LDK\_BITCOIND\_RPC\_USER="\_\_cookie\_\_"
 LDK\_BITCOIND\_RPC\_PASSWORD="f7460d81974b000b63e46c0e880243cf28bbaf93938b6e38494628f1f1700f23"
 # or use esplora
 #LDK\_ESPLORA\_SERVER=http://localhost:4002/api
 NETWORK="regtest"
 LDK\_LISTENING\_ADDRESSES="0.0.0.0:19735"
 BOLTZ\_API=http://localhost:9001
 PORT=8082
 MEMPOOL\_API=http://localhost:8123/api

And then run the frontend with: \`VITE\_API\_URL="http://localhost:8082" yarn dev:http\`

To test auto-swaps to xpub you can use sparrow wallet in regtest:

 /opt/sparrow/bin/Sparrow -n regtest

Sparrow needs to be connected to regtest boltz setup Bitcoin Core RPC (127.0.0.1:18443 with user:password as \`\_\_cookie\_\_:cookiepassword\`) with an imported mnemonic and copied the tpub from the settings page

\### Migrating the database (Sqlite <-> Postgres)

Migration of the database is currently experimental. Please make a backup before continuing.

\#### Migration from Sqlite to Postgres

1\. Stop the running hub
2\. Update the \`DATABASE\_URI\` to your destination e.g. \`postgresql://myuser:mypass@localhost:5432/nwc\`
3\. Run the migration:

 go run cmd/db\_migrate/main.go -from .data/nwc.db -to postgresql://myuser:mypass@localhost:5432/nwc

\## Node-specific backend parameters

\- \`ENABLE\_ADVANCED\_SETUP\`: set to \`false\` to force a specific backend type (combined with backend parameters below)

\### CLN Backend parameters

Can be configured via env or the UI

\- \`LN\_BACKEND\_TYPE\`: CLN
\- \`CLN\_ADDRESS\`: the CLN grpc address (grpc-host and grpc-port), e.g. \`127.0.0.1:9737\`
\- \`CLN\_LIGHTNING\_DIR\`: CLN's lightning directory containing the grpc certificates, usually \`~/.lightning/\`

Optional for hold invoice methods support:
\- \`CLN\_ADDRESS\_HOLD\`: the CLN hold plugin grpc address (grpc-host and grpc-port), e.g. \`127.0.0.1:9738\`

If you are copying the certificates to another machine make sure you get the \`ca.pem\`, \`client.pem\` and \`client-key.pem\` from the lightning directory and optionally from the \`hold\` directory inside the lightning directory and keep the sub-directory structure of the hold directory.

\### LND Backend parameters

LND can be configured via env. Other node types may need to be configured via the UI.

\_To configure via env, the following parameters must be provided:\_

\- \`LN\_BACKEND\_TYPE\`: LND
\- \`LND\_ADDRESS\`: the LND gRPC address, eg. \`localhost:10009\` (used with the LND backend)
\- \`LND\_CERT\_FILE\`: the location where LND's \`tls.cert\` file can be found (used with the LND backend)
\- \`LND\_MACAROON\_FILE\`: the location where LND's \`admin.macaroon\` file can be found (used with the LND backend)

\### LDK Backend parameters

\- \`LDK\_ESPLORA\_SERVER\`: By default the optimized Alby esplora is used. You can configure your own esplora server (note: the public blockstream one is slow and can cause onchain syncing and issues with opening channels)
\- \`LDK\_VSS\_URL\`: Use VSS (encrypted remote storage) rather than local sqlite store for lightning and bitcoin data. Currently this feature only works for brand new Alby Hub instances that are connected to Alby Accounts with an active subscription plan.
\- \`LDK\_LISTENING\_ADDRESSES\`: configure listening addresses, required for public channels, and ideally reachable if you would like others to be able to initiate peering with your node.
\- \`LDK\_ANNOUNCEMENT\_ADDRESSES\`: configure announcement addresses (only required if you use a VPN)
\- \`LDK\_MAX\_CHANNEL\_SATURATION\`: Sets the maximum portion of a channel's total capacity that may be used for sending a payment, expressed as a power of 1/2. See \`max\_channel\_saturation\_power\_of\_half\` in \[LDK docs\](https://docs.rs/lightning/latest/lightning/routing/router/struct.PaymentParameters.html#structfield.max\_channel\_saturation\_power\_of\_half).
\- \`LDK\_MAX\_PATH\_COUNT\`: Maximum number of paths that may be used by MPP payments.
\- \`LDK\_LOG\_LEVEL\`: Log level for the LDK node. Higher is more verbose. Default: 3. This is separate from the main application log level, allowing you to enable more verbose LDK logging (e.g., level 4, 5 or 6) without enabling verbose logging for the entire application.
\- \`LDK\_CHANNEL\_MONITOR\_WARNING\_SIZE\_BYTES\`: If a channel monitor is larger than this value, a performance warning will be shown on the node page.

\#### LDK Network Configuration

\##### Mutinynet

\- \`MEMPOOL\_API=https://mutinynet.com/api\`
\- \`NETWORK=signet\`
\- \`LDK\_ESPLORA\_SERVER=https://mutinynet.com/api\`
\- \`LDK\_GOSSIP\_SOURCE=https://rgs.mutinynet.com/snapshot\` (NOTE: by default ALby Hub does not use RGS)

(or electrum instead of esplora)

\- \`LDK\_ELECTRUM\_SERVER=electrum.mutinynet.com:50001\`

\##### Signet

\- \`MEMPOOL\_API=https://mempool.space/signet/api\`
\- \`LDK\_NETWORK=signet\`
\- \`LDK\_ESPLORA\_SERVER=https://mempool.space/signet/api\`

\##### Testnet (Not recommended - try Mutinynet)

\- \`MEMPOOL\_API=https://mempool.space/testnet/api\`
\- \`NETWORK=testnet\`
\- \`LDK\_ESPLORA\_SERVER=https://mempool.space/testnet/api\`
\- \`LDK\_GOSSIP\_SOURCE=https://rapidsync.lightningdevkit.org/testnet/snapshot\` (NOTE: by default ALby Hub does not use RGS)

\###### Connect to your own bitcoind

\- \`LDK\_BITCOIND\_RPC\_HOST=127.0.0.1\`
\- \`LDK\_BITCOIND\_RPC\_PORT=8332\`
\- \`LDK\_BITCOIND\_RPC\_USER=yourusername\`
\- \`LDK\_BITCOIND\_RPC\_PASSWORD=yourpassword\`

\### Phoenixd

See \[Phoenixd\](scripts/linux-x86\_64/phoenixd/README.md)

\### Alby OAuth

Create an OAuth client at the \[Alby Developer Portal\](https://getalby.com/developer) and set your \`ALBY\_OAUTH\_CLIENT\_ID\` and \`ALBY\_OAUTH\_CLIENT\_SECRET\` in your .env. If not running locally, you'll also need to change your \`BASE\_URL\`.

\> If running the React app locally, make sure to set \`FRONTEND\_URL=http://localhost:5173\` so that the OAuth redirect works.

\## Getting Started with Mutinynet

Follow the steps to integrate Mutinynet with your NWC Next setup:

1\. Configure your environment with the \[Mutinynet LDK parameters\](https://github.com/getAlby/hub#mutinynet)

2\. Proceed as described in the \[Development\](https://github.com/getAlby/hub#Development) section to run the frontend and backend

3\. Navigate to \`channels/outgoing\`, copy your On-Chain Address, then visit the \[Mutinynet Faucet\](https://faucet.mutinynet.com/) to deposit sats. Ensure the transaction confirms on \[mempool.space\](https://mutinynet.com/)

4\. Your On-chain balance will update under \`/channels\`

\### Opening a channel from Mutinynet

1\. To create a channel, use the \[Mutinynet Faucet\](https://faucet.mutinynet.com/) by entering your desired Channel Capacity and Amount to Push

2\. Locate your Node ID. In the Wallet click on the status on the top right "online". This shows the node ID or look in the NWC Next logs. Then input this in the Connection String field on the faucet page to request a Lightning Channel

\`\`\`
{"level":"info","msg":"Connected to LDK node","nodeId":"","time":""}
\`\`\`

3\. After the transaction confirms, the new channel will appear in the Channels section

\### Opening a Channel from Alby Hub

1\. From the Channels interface (\`/channels\`), select "Open a Channel" and opt for "Custom Channel."

2\. Enter the pubkey of the Faucet Lightning Node (omit host and port details) available on the \[Mutinynet Faucet\](https://faucet.mutinynet.com/) page.

3\. Specify a channel capacity greater than 25,000 sats, confirm the action, and return to the Channels page to view your newly established channel.

\### Running Multiple Hubs Locally

You can run multiple hubs locally to e.g. open channels between the two nodes or test sending payments between them. Currently this will only work with LDK.

You will need two copies of the alby hub repository.

For the second hub, you will need to update your .env with the following changes:

 FRONTEND\_URL=http://localhost:5174
 BASE\_URL=http://localhost:8081
 PORT=8081
 LDK\_LISTENING\_ADDRESSES=\[::\]:9736

Then launch the frontend with \`VITE\_PORT=5174 VITE\_API\_URL=http://localhost:8081 yarn dev:http\`

\## Application deeplink options

\### \`/apps/new\` deeplink options

Clients can use a deeplink to allow the user to add a new connection. Depending on the client this URL has different query options:

\#### NWC created secret

The default option is that the NWC app creates a secret and the user uses the nostr wallet connect URL string to enable the client application.

\##### Query parameter options

\- \`name\`: the name of the client app

Example:

\`/apps/new?name=myapp\`

\#### Client created secret

If the client creates the secret the client only needs to share the public key of that secret for authorization. The user authorized that pubkey and no sensitivate data needs to be shared.

\##### Query parameter options for /new

\- \`name\`: the name of the client app
\- \`pubkey\`: the public key of the client's secret for the user to authorize
\- \`return\_to\`: (optional) if a \`return\_to\` URL is provided the user will be redirected to that URL after authorization. The \`lud16\`, \`relay\` and \`pubkey\` query parameters will be added to the URL.
\- \`expires\_at\` (optional) connection cannot be used after this date. Unix timestamp in seconds.
\- \`max\_amount\` (optional) maximum amount in millisats that can be sent per renewal period
\- \`budget\_renewal\` (optional) reset the budget at the end of the given budget renewal. Can be \`never\` (default), \`daily\`, \`weekly\`, \`monthly\`, \`yearly\`
\- \`request\_methods\` (optional) url encoded, space separated list of request types that you need permission for: \`pay\_invoice\` (default), \`get\_balance\` (see NIP47). For example: \`..&request\_methods=pay\_invoice%20get\_balance\`
\- \`notification\_types\` (optional) url encoded, space separated list of notification types that you need permission for: For example: \`..¬ification\_types=payment\_received%20payment\_sent\`
\- \`isolated\` (optional) makes an isolated app connection with its own balance and only access to its own transaction list. e.g. \`&isolated=true\`. If using this option, you should not pass any custom request methods or notification types, nor set a budget or expiry.

Example:

\`/apps/new?name=myapp&pubkey=47c5a21...&return\_to=https://example.com\`

\#### Web-flow: client created secret

Web clients can open a new prompt popup to load the authorization page.
Once the user has authorized the app connection a \`nwc:success\` message is sent to the webview (using \`dispatchEvent\`) or opening page (using \`postMessage\`) to indicate that the connection is authorized. See the \`fromAuthorizationUrl()\` function in the \[alby-js-sdk\](https://github.com/getAlby/alby-js-sdk#nostr-wallet-connect-documentation)

\## Help

If you need help contact support@getalby.com or reach out on Nostr: npub1getal6ykt05fsz5nqu4uld09nfj3y3qxmv8crys4aeut53unfvlqr80nfm
You can also visit the chat of our Community on \[Telegram\](https://t.me/getalby).

\## ⚡️Donations

Want to support the work on Alby?

Support the Alby team ⚡️hello@getalby.com
You can also contribute to our \[bounty program\](https://github.com/getAlby/lightning-browser-extension/wiki/Bounties): ⚡️bounties@getalby.com

\## NIP-47 Supported Methods

✅ NIP-47 info event

❌ \`expiration\` tag in requests

\### LND

✅ \`get\_info\`

✅ \`get\_balance\`

✅ \`pay\_invoice\`

\- ⚠️ amount not supported (for amountless invoices)
\- ⚠️ PAYMENT\_FAILED error code not supported

✅ \`pay\_keysend\`

\- ⚠️ PAYMENT\_FAILED error code not supported

✅ \`make\_invoice\`

✅ \`lookup\_invoice\`

\- ⚠️ NOT\_FOUND error code not supported

✅ \`list\_transactions\`

\- ⚠️ from and until in request not supported
\- ⚠️ failed payments will not be returned

✅ \`multi\_pay\_invoice\`

\- ⚠️ amount not supported (for amountless invoices)
\- ⚠️ PAYMENT\_FAILED error code not supported

✅ \`multi\_pay\_keysend\`

\- ⚠️ PAYMENT\_FAILED error code not supported

\## Node Distributions

Run NWC on your own node!

\*\*NOTE: the below links are for the original version of NWC\*\*

\- \[https://github.com/getAlby/umbrel-community-app-store\](Umbrel)
\- \[https://github.com/horologger/nostr-wallet-connect-startos\](Start9)

\## Deploy it yourself

\### Requirements

The application has no runtime dependencies. (simple Go executable).

As data storage SQLite is used.

For the default backend which runs a node internally we recommend 2GB of RAM + 1GB of disk space (or 512MB RAM + 2GB swap can also be used). For connecting to an external node, Alby Hub uses very little RAM (256MB is enough).

\### From the release

\#### Quick start (x86 Linux Server)

Go to the \[Quick start script\](https://github.com/getAlby/hub/tree/master/scripts/linux-x86\_64) which you can run as a service.

\#### Quick start (Arm64 Linux Server)

Go to the \[Quick start script\](https://github.com/getAlby/hub/blob/master/scripts/linux-aarch64) which you can run as a service.

\#### Quick start (Raspberry PI 4/5)

Go to the \[Quick start script\](https://github.com/getAlby/hub/blob/master/scripts/pi-aarch64) which you can run as a service. (Experimental – we cannot provide support for installations on Raspberry PI 4/5.)

\#### Quick start (Raspberry PI Zero)

Go to the \[Quick start script\](https://github.com/getAlby/hub/tree/master/scripts/pi-arm) which you can run as a service. (Experimental – we cannot provide support for installations on Raspberry PI Zero.)

\#### Quick start (Desktop)

View the \[release binaries\](https://github.com/getAlby/hub/releases/latest). Please use a desktop computer that is always online.

\#### Manual (x86 Linux Server)

Download and run the executable.

Have a look at the \[configuration options\](#optional-configuration-parameters)

\`\`\`bash
wget https://getalby.com/install/hub/server-linux-x86\_64.tar.bz2
tar -xvjf server-linux-x86\_64.tar.bz2

\# run Alby Hub and done!
./bin/albyhub
\`\`\`

\### Fly.io

Make sure to have the \[fly command line tools installed \](https://fly.io/docs/hands-on/install-flyctl/)

\`\`\`bash
wget https://getalby.com/install/hub/fly.toml
fly launch
fly apps open
\`\`\`

Or manually:

\- update \`app = 'nwc'\` on \*\*line 6\*\* to a unique name in fly.toml e.g. \`app = 'nwc-john-doe-1234'\`
\- run \`fly launch\`
 \- press 'y' to copy configuration to the new app and then hit enter
 \- press 'n' to tweak the settings and then hit enter
 \- wait for the deployment to succeed, it should give you a URL like \`https://nwc-john-doe-1234.fly.dev\`

\#### Update Fly App

\- run \`fly deploy\`

\#### View logs

Main application logs

\- \`fly logs\`

LDK logs:

\- \`fly machine exec "tail -100 data/ldk/logs/ldk\_node\_latest.log"\`

\### Docker

Alby provides container images for each release. Please make sure to use a persistent volume. The lightning state and application state is persisted to disk.

\#### From Alby's Container Registry

\_Tested on Linux only\_

\`docker run -v ~/.local/share/albyhub:/data -e WORK\_DIR='/data' -p 8080:8080 --pull always ghcr.io/getalby/hub:latest\`

\##### Build the image locally

\`docker run -v ~/.local/share/albyhub:/data -e WORK\_DIR='/data' -p 8080:8080 $(docker build -q .)\`

\##### Docker Compose

In this repository. Or manually download the docker-compose.yml file and then run:

\`docker compose up\`

\#### From source

\- install go (e.g. using snap)
\- install build-essential
\- install yarn
\- run \`(cd frontend && yarn install\`
\- run \`(cd frontend && yarn build:http)\`
\- run \`go run cmd/http/main.go\`

\### Render.com

\[!\[Deploy to Render\](https://render.com/images/deploy-to-render-button.svg)\](https://render.com/deploy?repo=https://github.com/getAlby/hub)

\## Alby Hub Architecture

\### NWC Wallet Service

At a high level Alby Hub is an \[NWC\](https://nwc.dev) wallet service which allows users to use their single wallet seamlessly within a multitude of apps(clients). Any client that supports NWC and has a valid connection secret can communicate with the wallet service to execute commands on the underlying wallet (internally called LNClient).

\### LNClient

The LNClient interface abstracts the differences between wallet implementations and allows users to run Alby Hub with their preferred wallet, such as LDK, LND, Phoenixd, Cashu.

\### Transactions Service

Alby Hub maintains its own database of transactions to enable features like self-payments for isolated app connections (sub-wallets), additional metadata (that apps can provide when creating invoices or making keysend payments), and to associate transactions with apps, providing additional context to users about how their wallet is being used across apps.

The transactions service sits between the LNClient and two possible entry points: the NIP-47 handlers, and our internal API which is used by the Alby Hub frontend.

\### Event Publisher

Internally Alby Hub uses a basic implementation of the pubsub messaging pattern which allows different parts of the system to fire or consume events. For example, the LNClients can fire events when they asynchronously receive or send a payment, which is consumed by the transaction service to update our internal transaction database, and then fire its own events which can be consumed by the NIP-47 notifier to publish notification events to subscribing apps, and also by the Alby OAuth service to send events to the Alby Account (to enable features such as encrypted static channel backups, email notifications of payments, and more).

\#### Published Events

 \- \`nwc\_started\` - when Alby Hub process starts
 \- \`nwc\_stopped\` - when Alby Hub process gracefully exits
 \- \`nwc\_node\_started\` - when Alby Hub successfully starts or connects to the configured LNClient.
 \- \`nwc\_node\_start\_failed\` - The LNClient failed to sync or could not be connected to (e.g. network error, or incorrect configuration for an external node)
 \- \`nwc\_node\_stopped\` the LNClient was gracefully stopped
 \- \`nwc\_node\_stop\_failed\` - failed to request the node to stop. Ideally this never happens.
 \- \`nwc\_node\_sync\_failed\` - the node failed to sync onchain, wallet or fee estimates.
 \- \`nwc\_unlocked\` - when user enters correct password (HTTP only)
 \- \`nwc\_channel\_ready\` - a new channel is opened, active and ready to use
 \- \`nwc\_channel\_closed\` - a channel was closed (could be co-operatively or a force closure)
 \- \`nwc\_backup\_channels\` - send a list of channels that can be used as a SCB.
 \- \`nwc\_outgoing\_liquidity\_required\` - when user tries to pay an invoice more than their current outgoing liquidity across active channels
 \- \`nwc\_incoming\_liquidity\_required\` - when user tries to creates an invoice more than their current incoming liquidity across active channels
 \- \`nwc\_permission\_denied\` - a NIP-47 request was denied - either due to the app connection not having permission for a certain command, or the app does not have insufficient balance or budget to make the payment.
 \- \`nwc\_payment\_failed\` - failed to make a lightning payment
 \- \`nwc\_payment\_sent\` - successfully made a lightning payment
 \- \`nwc\_payment\_received\` - received a lightning payment
 \- \`nwc\_hold\_invoice\_accepted\` - accepted a lightning payment, but it needs to be cancelled or settled
 \- \`nwc\_hold\_invoice\_canceled\` - accepted hold payment was explicitly cancelled
 \- \`nwc\_budget\_warning\` - successfully made a lightning payment, but budget is nearly exceeded
 \- \`nwc\_app\_created\` - a new app connection was created
 \- \`nwc\_app\_deleted\` - a new app connection was deleted
 \- \`nwc\_lnclient\_\*\` - underlying LNClient events, consumed only by the transactions service.
 \- \`nwc\_alby\_account\_connected\` - user connects alby account for first time
 \- \`nwc\_swap\_succeeded\` - successfully made a boltz swap
 \- \`nwc\_rebalance\_succeeded\` - successfully rebalanced channels
 \- \`nwc\_payment\_forwarded\` - successfully forwarded a payment and earned routing fees

\### NIP-47 Handlers

Alby Hub subscribes to a standard Nostr relay and listens for whitelisted events from known pubkeys and handles these requests in a similar way as a standard HTTP API controller, and either doing requests to the underling LNClient, or to the transactions service in the case of payments and invoices.

\### Frontend

The Alby Hub frontend is a standard React app that can run in one of two modes: as an HTTP server, or desktop app, built by Wails. To abstract away, both the HTTP service and Wails handlers pass requests through to the API, where the business logic is located, for direct requests from user interactions.

\#### Authentication

Alby Hub uses simple JWT auth in HTTP mode, which also allows the HTTP API to be exposed to external apps, which can use Alby Hub's API to have access to extra functionality currently not covered by the NIP-47 spec, however there are downsides - this API is not a public spec, and only works over HTTP. Therefore, apps are recommended to use NIP-47 where possible.

\### Encryption

Sensitive data such as the seed phrase are saved AES-encrypted by the user's unlock password, and only decrypted in-memory in order to run the lightning node. This data is not logged and is only transferred over encrypted channels, and always requires the user's unlock password to access.

All requests to the wallet service are made with one of the following ways:

\- NIP-47 - requests encrypted by NIP-04 using randomly-generated keypairs (one per app connection) and sent via websocket through the configured relay.
\- HTTP - requests encrypted by JWT and ideally HTTPS (except self-hosted, which can be protected by firewall)
\- Desktop mode - requests are made internally through the Wails router, without any kind of network traffic.

\## Alby Hub Origin

Alby Hub is a self-sovereign, self-custodial, single-user \[NWC\](https://nwc.dev)-first rewrite of the original \[Nostr Wallet Connect\](https://github.com/getAlby/nostr-wallet-connect) app which was originally created to support V4V by enabling seamless zaps in nostr clients such as Amethyst and Damus. From there the NIP-47 protocol was grown until it is possible to create many micro apps that connect to your hub, with full control over what each app can do.