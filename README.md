# HexaChess

HexaChess is a six-army chess variant played in a 3D volume. Local games, bot opponents, and the six-bot demo run in the browser. Online rooms share their match state through a Cloudflare Worker backed by D1.

## GitHub Pages

1. Push the source to your GitHub repository.
2. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the source.
3. Push to the default branch or run **Deploy HexaChess to GitHub Pages** from the **Actions** tab.

The workflow builds and publishes `dist-pages/`. Internal links and assets work both at a domain root and under a repository path such as `https://OWNER.github.io/REPOSITORY/`.

Run the static build locally with Node.js 24.

```sh
npm run build:pages
```

## Online rooms on GitHub Pages

Deploy a standalone Cloudflare Worker named `hexachess-rooms`, then configure the Pages build with its URL. Wrangler creates the Worker from the included configuration and room service. A Pages build without a room service offers local play and bot matches.

1. Install the project dependencies and create a D1 database.

   ```sh
   npm ci
   npx wrangler login
   npx wrangler d1 create hexachess-rooms
   cp wrangler.example.jsonc wrangler.jsonc
   ```

2. In `wrangler.jsonc`, paste the returned `database_id`. Set `HEXACHESS_FRONTEND_ORIGIN` to your exact Pages origin, such as `https://OWNER.github.io`. For a custom domain, use that domain’s HTTPS origin. Leave the repository path out of this value.
3. Apply the migration, build, and deploy the Worker.

   ```sh
   npx wrangler d1 migrations apply hexachess-rooms --remote
   npm run build
   npx wrangler deploy
   ```

4. In GitHub, set the `HEXACHESS_API_URL` repository variable under **Settings → Secrets and variables → Actions → Variables**. Use the Worker’s HTTPS origin, such as `https://hexachess-rooms.ACCOUNT.workers.dev`. Run the Pages workflow again to enable **Online**.

Room invites point to the Pages site. Players use the Worker for room state, turn validation, and bot moves.
