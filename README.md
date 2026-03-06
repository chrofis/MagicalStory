# MagicalStory

A multilingual AI-powered children's storybook platform that creates personalized stories with AI-generated illustrations.

**Live Site:** [www.magicalstory.ch](https://www.magicalstory.ch)

---

## Features

- **Multi-language Support:** English, German, and French
- **Character Creation:** Upload photos, define traits, strengths, weaknesses, fears
- **AI Photo Analysis:** Gemini extracts character features from uploaded photos
- **Relationship Mapping:** Define how characters relate to each other
- **AI Story Generation:** Claude generates age-appropriate stories
- **AI Image Generation:** Gemini creates illustrations matching your characters
- **Multiple Art Styles:** Cartoon, watercolor, comic book, and more
- **Cover Generation:** Front cover, back cover, and dedication page
- **Print Ordering:** Order printed hardcover books via Gelato
- **PDF Download:** Generate and download story as PDF

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| Backend | Node.js + Express.js |
| Database | PostgreSQL |
| AI Text | Claude (Anthropic) |
| AI Images | Gemini (Google) |
| Auth | Firebase Authentication |
| Email | Resend |
| Payments | Stripe |
| Print | Gelato |
| Hosting | Railway |

---

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL database
- API keys: Anthropic, Google AI, Firebase, Resend, Stripe

### Local Development

```bash
# Clone repository
git clone https://github.com/chrofis/MagicalStory.git
cd MagicalStory

# Install dependencies
npm install
cd client && npm install && cd ..

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Start development servers
npm run dev          # Backend: http://localhost:3000
cd client && npm run dev  # Frontend: http://localhost:5173
```

### Production Deployment

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for Railway/Render deployment instructions.

---

## Documentation

| Document | Description |
|----------|-------------|
| [DOCUMENTATION.md](DOCUMENTATION.md) | Master documentation index |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Deployment instructions |
| [EMAIL_SETUP_GUIDE.md](EMAIL_SETUP_GUIDE.md) | Email configuration |
| [docs/PIPELINE_ANALYSIS.md](docs/PIPELINE_ANALYSIS.md) | Story generation pipeline |

---

## Project Structure

```
MagicalStory/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Page components
│   │   ├── services/       # API clients
│   │   ├── context/        # React contexts
│   │   └── types/          # TypeScript types
│   └── public/
├── server.js               # Express backend
├── email.js                # Email utilities
├── prompts/                # AI prompt templates
├── docs/                   # Documentation
└── requirements/           # Future architecture specs
```

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://...

# AI APIs
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...

# Firebase
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}

# Email
RESEND_API_KEY=re_...

# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Gelato
GELATO_API_KEY=...
```

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

---

## License

MIT License

---

## Support

- **Issues:** [GitHub Issues](https://github.com/chrofis/MagicalStory/issues)
- **Website:** [www.magicalstory.ch](https://www.magicalstory.ch)
