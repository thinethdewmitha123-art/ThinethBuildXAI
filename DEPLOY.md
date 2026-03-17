# How to Deploy BuildX AI 🚀

Since this is a web application (Vite + React), the easiest way to make it public is using **Vercel** or **Netlify**. Both are free for personal projects.

## Option 1: Deploy to Vercel (Recommended)

Vercel is optimized for this kind of app.

### Method A: Drag & Drop (Easiest)
1. Run the build command in your terminal:
   ```bash
   npm run build
   ```
   This creates a `dist` folder in your project directory.

2. Go to [vercel.com](https://vercel.com) and sign up/login.
3. Click **"Add New..."** -> **"Project"**.
4. Drag and drop the `dist` folder directly onto the Vercel dashboard.
5. Visit your new URL!

### Method B: Using Vercel CLI
1. Install Vercel CLI:
   ```bash
   npm install -g vercel
   ```
2. Run the deploy command:
   ```bash
   vercel
   ```
3. Follow the prompts (press Enter for defaults).
4. It will give you a `Production` URL (e.g., `https://buildx-ai.vercel.app`).

---

## Option 2: Deploy to Netlify

### Method A: Drag & Drop

> ⚠️ **IMPORTANT:** You must drag **ONLY the `dist` folder itself** — not the whole project folder. Dragging the entire project will cause a "Site not found" error because Netlify won't know where the built files are.

1. Run the build command in your terminal:
   ```bash
   npm run build
   ```
   This creates a `dist` folder inside your project directory.

2. Go to [netlify.com](https://netlify.com) and sign up/login.
3. On the "Sites" page, drag and drop the **`dist`** folder (found at `d:\projects ai\teen ai project\dist`).
4. That's it! You'll get a URL like `https://silly-name-12345.netlify.app`.

### Method B: Using Netlify CLI (Alternative)
1. Install Netlify CLI:
   ```bash
   npm install -g netlify-cli
   ```
2. Build and deploy:
   ```bash
   npm run build
   netlify deploy --prod --dir=dist
   ```
3. Follow the prompts to link or create a new site.

### Troubleshooting: "Site not found" on Netlify
If you see a "Site not found" or "Page not found" error:
- **Cause:** You likely dragged the entire project folder instead of just the `dist` folder.
- **Fix:** Delete the old site on Netlify, run `npm run build` again, and drag **only** the `dist` folder.

---

## ⚠️ Important Note About API Keys

Since your app uses the **Google Gemini API**, users will need to enter their OWN API key when they visit your public URL, just like you did locally.

If you want to host it for others without them needing a key, you would need a backend server (which costs money and is more complex). For now, **users bringing their own key is the safest and free way** to share the app.
