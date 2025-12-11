// api/cron.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default async function handler(req, res) {
  // Only allow cron requests from Vercel
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Import and run the build script
    await import('../build-report.js');
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Cron build failed:', error);
    res.status(500).json({ error: 'Build failed' });
  }
}
