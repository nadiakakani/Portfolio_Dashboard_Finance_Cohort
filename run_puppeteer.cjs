const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  
  // Wait for the UI to be ready
  await page.waitForSelector('#btn-fetch-run', { timeout: 10000 });
  await page.click('#btn-fetch-run');
  
  // Wait for the diagnostic content to populate
  await page.waitForFunction(() => {
    const el = document.getElementById('volume-recalibration-content');
    return el && !el.textContent.includes('Run analysis');
  }, { timeout: 60000 });
  
  const content = await page.$eval('#volume-recalibration-content', el => el.textContent);
  console.log(content);
  
  await browser.close();
})();
