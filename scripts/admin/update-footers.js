const fs = require('fs');
const path = require('path');

const files = [
  'story-complete.html', 'story-failed.html', 'order-confirmation.html',
  'order-shipped.html', 'order-failed.html', 'email-verification.html', 'password-reset.html'
];

const oldHtmlFooter = `  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0 20px;">
  <div style="text-align: center;">
    <a href="https://www.magicalstory.ch">
      <img src="https://www.magicalstory.ch/images/email-logo.png" alt="MagicalStory" style="height: 60px; width: auto;">
    </a>
    <p style="color: #999; font-size: 12px; margin: 10px 0 0;">
      <a href="https://www.magicalstory.ch" style="color: #999; text-decoration: none;">www.magicalstory.ch</a>
    </p>
  </div>`;

function makeHtmlFooter(tagline, questionText, location) {
  return `  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0 20px;">
  <table style="width: 100%;" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align: middle; width: 70px;">
        <a href="https://www.magicalstory.ch">
          <img src="https://www.magicalstory.ch/images/email-logo.png" alt="MagicalStory" style="height: 50px; width: auto;">
        </a>
      </td>
      <td style="vertical-align: middle; padding-left: 15px; color: #999; font-size: 12px; line-height: 1.6;">
        ${tagline}<br>
        <a href="https://www.magicalstory.ch" style="color: #999; text-decoration: none;">www.magicalstory.ch</a><br>
        ${questionText} <a href="mailto:support@magicalstory.ch" style="color: #999;">support@magicalstory.ch</a><br>
        MagicalStory, ${location}
      </td>
    </tr>
  </table>`;
}

const footersByLang = {
  en: makeHtmlFooter("MagicalStory - Personalized AI-Generated Children's Books", 'Questions?', 'Switzerland'),
  de: makeHtmlFooter('MagicalStory - Personalisierte KI-generierte Kinderbücher', 'Fragen?', 'Schweiz'),
  fr: makeHtmlFooter('MagicalStory - Livres pour enfants personnalises generes par IA', 'Des questions?', 'Suisse')
};

const textReplacements = [
  { old: "MagicalStory - Personalized AI-Generated Children's Books\nwww.magicalstory.ch\n---",
    new: "MagicalStory - Personalized AI-Generated Children's Books\nwww.magicalstory.ch\nQuestions? support@magicalstory.ch\nMagicalStory, Switzerland\n---" },
  { old: 'MagicalStory - Personalisierte KI-generierte Kinderbücher\nwww.magicalstory.ch\n---',
    new: 'MagicalStory - Personalisierte KI-generierte Kinderbücher\nwww.magicalstory.ch\nFragen? support@magicalstory.ch\nMagicalStory, Schweiz\n---' },
  { old: 'MagicalStory - Livres pour enfants personnalises generes par IA\nwww.magicalstory.ch\n---',
    new: 'MagicalStory - Livres pour enfants personnalises generes par IA\nwww.magicalstory.ch\nDes questions? support@magicalstory.ch\nMagicalStory, Suisse\n---' },
];

const emailsDir = path.join('C:\\Users\\roger\\MagicalStory', 'emails');

for (const file of files) {
  const filePath = path.join(emailsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Normalize to LF for consistent matching
  content = content.replace(/\r\n/g, '\n');

  // Split by language markers to apply per-language HTML footers
  const parts = content.split(/(\[(?:ENGLISH|GERMAN|FRENCH)\])/);
  let currentLang = null;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '[ENGLISH]') { currentLang = 'en'; continue; }
    if (parts[i] === '[GERMAN]') { currentLang = 'de'; continue; }
    if (parts[i] === '[FRENCH]') { currentLang = 'fr'; continue; }

    if (currentLang && parts[i].includes(oldHtmlFooter)) {
      parts[i] = parts[i].replace(oldHtmlFooter, footersByLang[currentLang]);
    }
  }

  content = parts.join('');

  // Replace text footers (language-specific, so safe to replaceAll)
  for (const tr of textReplacements) {
    content = content.replaceAll(tr.old, tr.new);
  }

  fs.writeFileSync(filePath, content, 'utf-8');

  // Verify
  const hasOldCentered = content.includes('text-align: center');
  const tableCount = (content.match(/cellpadding="0" cellspacing="0"/g) || []).length;
  const schweiz = content.includes('Schweiz');
  const suisse = content.includes('Suisse');
  const switzerland = content.includes('Switzerland');
  console.log(`${file}: tables=${tableCount}, EN=${switzerland}, DE=${schweiz}, FR=${suisse}, oldCenteredRemains=${hasOldCentered}`);
}

console.log('\nDone!');
