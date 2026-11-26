# Running Nimroz in GitHub Codespaces

This configuration runs Node.js 22, Bun 1.3.4, and a separate MySQL 8.4
development database. It does not import your local database or biometric data.
The database credentials in compose.yaml are disposable development credentials.
MySQL has no published host port.

## First upload

From the project directory, review the files before making the first commit:

```sh
git status --short
git add .
git diff --cached --stat
git commit -m "Initial project with Codespaces setup"
git branch -M main
git remote add origin https://github.com/mnrafg/nimroz-sys.git
git push -u origin main
```

If origin already exists, use `git remote set-url origin https://github.com/mnrafg/nimroz-sys.git`
instead of `git remote add`. Keep the repository private for this internal system.
The ignore rules exclude .env, db/, .local/, and tool-results/. Review other
source files and documents for private information before uploading.

## Create and start

1. Open the repository on GitHub, choose **Code → Codespaces → Create codespace on main**.
2. Wait for container setup and dependency installation to finish.
3. In the Codespaces terminal, initialize the new database:

   ```sh
   bun run db:push
   bun run db:seed
   ```

   Confirm DATABASE_URL in .env targets the development MySQL service before
   running these commands. The seed creates an administrator and sample records;
   it preserves existing administrator credentials on repeat runs.

4. Start the application:

   ```sh
   bun run dev --hostname 0.0.0.0
   ```

5. In the **Ports** tab, open port **3000** in your browser. Keep visibility **Private**.
6. Log in with `admin@localhost` and the generated `SEED_ADMIN_PASSWORD` in the
   Codespace's .env file. Avoid pasting that password into logs, commits, or chat.

After stopping and reopening a Codespace, run the dev command again. If setup
failed, rerun `bash .devcontainer/setup.sh`. Rebuild the container after changing
its configuration.

## Data and device limitations

MySQL data uses a Docker named volume and is not committed to Git. Back up any
data you need before deleting a Codespace; do not rely on it for permanent storage.
Store real credentials in Codespaces secrets when connecting external services.

Codespaces is a development environment with idle shutdown, not permanent
production hosting. The application is reachable only while its server and
Codespace are running.

Direct LAN biometric terminals on a private office network cannot be reached
from Codespaces without additional networking. The optional ADMS service is not
started by this configuration; configure a reachable external ADMS service
separately if needed. Do not expose device services by making the web port public.

GitHub documentation:
- https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/setting-up-your-nodejs-project-for-codespaces
