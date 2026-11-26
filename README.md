
# Weblox
### *aka web-blox*

---

## Prerequisites

Before getting started, make sure you have:

- **[Bun](https://bun.sh/)** - Recommended package manager. pnpm and npm are also supported.
- **A Linux or Windows server/VPS** — Approximately 8 GB of RAM recommended.
- **24/7 Runtime** — Your server should remain online for continuous access.

---

## How to Self-Host

Choose what method you want

### Easy Method

Get Weblox up and running with a single command:

```bash
git clone https://github.com/puiaiu/weblox && cd weblox && bun i && bun start
```

### Manual Installation

Prefer doing things yourself? Follow these steps:

**1. Clone the repository**

```bash
git clone https://github.com/puiaiu/weblox
```

**2. Navigate into the project and install dependencies**

```bash
cd weblox && bun i
```

**3. Start the server**

```bash
bun start
```

**4. Make your server accessible**

To access Weblox outside your local network, either:

- **Port Forwarding:** Forward the required port through your router.
- **Tunneling:** Use a tunnel service to expose your server through a domain.

---

**You're all set!** Your self-hosted Weblox instance should now be running.
