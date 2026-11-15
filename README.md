# The Daily Differential

A personal, distraction-free daily newspaper styled in a classic broadsheet layout. No ads, pop-ups, paywalls, or trackers. Every morning, an automated GitHub Action gathers stories from public RSS feeds and republishes your private edition.

**Sections:** Vertical Thinking in Medical Science · Medicine & Therapeutics · Surgery & Operative Innovation · Emerging Medical Trends & New Vocabulary (featuring a Medical Word of the Day) · Thought-Provoking Lectures in Medical Science · Related Articles  
**Features:** Daily briefing dashboard (article count, reading time, trending keywords, and market indicators), profile-based saved articles, a clean reader view, and a 30-day edition archive.

---

## Where to View

| Access Method | URL / Location |
|---|---|
| **Live Web Edition** *(after setup)* | `https://saurabhsrivastav-in.github.io/daily-differential/` |
| **Local Computer** | `http://localhost:8000` *(see [Run Locally](#run-locally))* |

> **Note:** Your live web URL becomes active only after completing steps 1–6 below (find your exact link under **Settings → Pages**). Double-clicking `docs/index.html` directly from your file explorer will not work, as modern browsers block local files from loading external JSON data.

---

## Quick Setup (No Coding Required · ~15 Minutes)

1. **Create a GitHub Account:** Sign up for free at [github.com](https://github.com).
2. **Create a Repository:** Click **+ → New repository**. Name it `daily-differential`, set visibility to **Public**, leave **Add a README file** unchecked, and click **Create repository**.
3. **Upload Project Files:** Click **uploading an existing file**, drag all contents from inside your unzipped project folder into the browser, and click **Commit changes**.
   * *Hidden folder tip:* The `.github` folder is hidden by default. Press `Cmd + Shift + .` on Mac, or enable **View → Show → Hidden items** on Windows before dragging. If it still fails to upload, click **Add file → Create new file**, name it `.github/workflows/daily.yml`, paste the workflow contents, and commit.
4. **Enable GitHub Pages:** Navigate to **Settings → Pages**, and set **Source** to **GitHub Actions**.
5. **Grant Workflow Permissions:** Navigate to **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**, and click **Save**.
6. **Generate Your First Edition:** Open the **Actions** tab (enable workflows if prompted), select **Daily Differential Edition → Run workflow**, and wait 2–4 minutes for the green checkmark.

Open the URL listed in **Settings → Pages** and bookmark it. Your newspaper will now update automatically every morning.

**Prefer Vercel?** After completing step 6, log into [vercel.com](https://vercel.com) with GitHub, select **Add New → Project**, import your repository, keep the default settings (`vercel.json` automatically routes to `docs`), and click **Deploy**.

---

## Using Your Newspaper

* **Read:** Click any headline to open the original article. Openly licensed sources (tagged with `min read`) open directly inside a clean, distraction-free reader view.
* **Filter:** Click any trending keyword in the dashboard to filter stories by topic.
* **Save Articles:** Click **☆ Save** on any story. On first use, you will be prompted for your name to create a local profile. Open **★ Saved** to search, manage, or switch profiles.
* **Backup & Export:** Because saved articles are stored locally in your browser, use **Download JSON** (and **Import JSON** to restore) for backups, or **Download Markdown** to export a reading list for your notes app.
* **Archive & Display:** Browse the past 30 days via the date drop-down, adjust font sizes, toggle day/night themes, or print cleanly using your browser's print function.

---

## Customizing Your Edition

To tailor your newspaper, open `scripts/feeds.json` on GitHub and click the **pencil (edit)** icon. Committing any change automatically triggers a fresh build.

| What You Want to Change | Section to Edit in `feeds.json` |
|---|---|
| Newspaper title, tagline, or timezone | `edition` |
| Add or remove RSS news sources | Feed URLs within each
