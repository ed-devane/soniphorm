# Soniphorm Website

Modern, dark-themed website for Soniphorm - Tools for sonic exploration.

**Live Site:** [www.soniphorm.com](https://www.soniphorm.com)

## Overview

Handcrafted instruments and audio devices from Donegal, Ireland.

### Current State

The site is currently a rebuild of the existing Weebly store, featuring:

- Auto-rotating product carousel
- PayPal integration for direct purchases
- Regional shipping calculator
- Comprehensive FAQ section
- Responsive dark theme design

### Vision

This site will evolve into the central hub for all Soniphorm activities:

**Products & Hardware**
- Contact microphones and audio devices (current offering)
- New ESP32-based audio device product line
- Patcher program for configuring ESP32 devices

**Education & Services**
- Studio workshops (in-person, Donegal)
- Mentoring sessions (online/in-person)
- Booking calendar with integrated payments to confirm reservations

**Content & Community**
- Podcast series (planned)
- Discord community for software support and user discussions
- Audio webapps and interactive tools

**Key Features Needed**
- Calendar/booking system with advance payment
- Integration with Discord for community support
- Patcher/configuration tool for ESP32 devices
- Podcast hosting/embedding

## Products

1. **Active Magnetic Contact Microphone** - €100 (single) / €180 (pair)
   - XLR, 48V phantom power, built-in preamp
   - Best seller

2. **Active Exciter System** - €180 (2-channel) / €250 (4-channel)
   - Complete multi-channel vibration speaker system

3. **Passive Magnetic Contact Microphone** - €60
   - No phantom power required, mini jack or 1/4"

4. **SoundSniffer Kit** - €120
   - 3 input stages: electromagnetic coil, piezo, electret mic
   - Legacy product (Gen system coming soon)

## Project Structure

```
soniphorm/
├── index.html              # Home page with carousel
├── products.html           # Product catalog with PayPal
├── contact.html            # Contact info + FAQ
├── CNAME                   # Domain configuration
├── .gitignore             # Git ignore rules
├── css/
│   └── styles.css         # Dark theme styles
├── js/
│   ├── carousel.js        # Auto-rotating carousel
│   └── shipping.js        # Shipping calculator + PayPal
└── images/
    ├── placeholder.svg    # Placeholder for missing images
    └── README.md          # Image guidelines
```

## Setup Instructions

### 1. Add Product Images

Add your product images to the `images/` folder:

- `active-contact-mic.jpg` - Active Magnetic Contact Microphone
- `active-exciter.jpg` - Active Exciter System
- `passive-contact-mic.jpg` - Passive Magnetic Contact Microphone
- `soundsniffer.jpg` - SoundSniffer Kit

**Recommended specs:** 1200x800px, JPG/PNG, high quality

### 2. Configure PayPal Integration

**IMPORTANT:** Replace the PayPal Client ID in `products.html`:

1. Go to [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/)
2. Create a new app or use existing app
3. Copy your **Client ID**
4. In `products.html`, find this line:
   ```html
   <script src="https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&currency=EUR"></script>
   ```
5. Replace `YOUR_CLIENT_ID` with your actual PayPal Client ID

**Testing:** Use sandbox credentials for testing before going live.

### 3. Test Locally

Open `index.html` in your web browser to test locally, or use a local server:

```bash
# Python 3
python -m http.server 8000

# Node.js
npx serve

# PHP
php -S localhost:8000
```

Then visit `http://localhost:8000` in your browser.

## Deployment to GitHub Pages

### Initial Setup

1. **Create GitHub Repository:**
   ```bash
   cd soniphorm
   git init
   git add .
   git commit -m "Initial commit: Soniphorm website"
   ```

2. **Push to GitHub:**
   ```bash
   git remote add origin https://github.com/ed-devane/soniphorm.git
   git branch -M main
   git push -u origin main
   ```

3. **Enable GitHub Pages:**
   - Go to repository Settings → Pages
   - Source: Deploy from branch `main`
   - Folder: `/ (root)`
   - Click Save

4. **Configure Custom Domain:**
   - In GitHub Pages settings, add custom domain: `www.soniphorm.com`
   - Update your DNS settings with your domain registrar:
     - Add a CNAME record: `www` → `ed-devane.github.io`
     - Optionally add A records for root domain to GitHub IPs
   - Wait for DNS propagation (can take 24-48 hours)

### Updating the Site

After making changes:

```bash
git add .
git commit -m "Description of changes"
git push origin main
```

GitHub Pages will automatically rebuild and deploy (usually takes 1-2 minutes).

## Configuration Checklist

Before going live:

- [ ] Add all product images to `images/` folder
- [ ] Replace PayPal Client ID in `products.html`
- [ ] Test all PayPal buttons in sandbox mode
- [ ] Verify shipping calculator works correctly
- [ ] Test on mobile devices (responsive design)
- [ ] Check all links work (YouTube, Instagram, etc.)
- [ ] Test carousel auto-rotation
- [ ] Verify FAQ accordion functionality
- [ ] Configure custom domain DNS
- [ ] Enable HTTPS in GitHub Pages settings

## PayPal Configuration Details

Your PayPal setup:
- **Email:** ed@soniphorm.com
- **Currency:** EUR (€)
- **Products configured:** 6 buttons (see `shipping.js`)

After purchase, customers will:
1. Complete payment via PayPal
2. Receive order confirmation with Order ID
3. You'll contact them about shipping options (standard/tracked)
4. Lead time: 1-2 weeks

## Roadmap

### Phase 1 - Foundation
- [ ] Migrate from Weebly to this site as primary store
- [ ] Set up Discord server for community/support
- [ ] Add Discord widget to site

### Phase 2 - Booking & Payments
- [ ] Calendar integration for workshops and mentoring
- [ ] Advance payment system for booking confirmations
- [ ] Workshop/session scheduling interface

### Phase 3 - ESP32 Product Line
- [ ] Patcher program for ESP32 device configuration
- [ ] Documentation and tutorials
- [ ] Discord integration for software support

### Phase 4 - Content
- [ ] Podcast series launch and embedding
- [ ] Audio webapps and interactive tools
- [ ] Video tutorials and demos

### Legacy Plans
- **Gen System** - Next-generation sonic exploration platform

## Shipping Information

**Costs by Region:**
- **Light Items (Contact Mics, SoundSniffer):** Ireland €6-8, UK €10-12, EU €12-15, World €18-20
- **Heavy Items (Active Systems):** Ireland €22-28, UK €25-30, EU €28-35, World €30-35

**Options:**
- Standard post (no tracking, ~40% cheaper)
- Registered/tracked post (includes tracking)

**Shipping via:** An Post (Ireland's postal service)

## Contact

- **Email:** ed@soniphorm.com
- **YouTube:** [@soniphorm](https://www.youtube.com/@soniphorm)
- **Instagram:** [@soniphorm](https://www.instagram.com/soniphorm)
- **Portfolio:** [www.eddevane.com](https://www.eddevane.com)

## Tech Stack

- Pure HTML/CSS/JavaScript (no frameworks)
- Google Fonts: Karla, Catamaran
- PayPal SDK for payments
- GitHub Pages for hosting
- Responsive design (mobile-first)

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Android)

## License

© 2025 Soniphorm. All rights reserved.

---

**Built with Claude Code**

Created for Ed Devane | Soniphorm | Donegal, Ireland
