import Link from "next/link";
import type { Metadata } from "next";
import LiveMarkets, { MarketSnapshotProvider } from "./components/live-markets";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "PayPal Markets | A clearer view of crypto",
  description: "A PayPal hackathon concept for crypto market context, manual portfolio estimates, and Channel3 product discovery alongside Venmo.",
};

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function BrandMark() {
  return <span className={styles.mark} aria-hidden="true"><i /><i /></span>;
}

export default function Home() {
  return (
    <div className={styles.site}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="PayPal Markets home">
          <BrandMark />
          <span>PayPal <b>Markets</b></span>
        </Link>
        <nav className={styles.nav} aria-label="Main navigation">
          <a href="#markets">Markets</a>
          <a href="#experience">The experience</a>
          <a href="#discovery">Product discovery</a>
        </nav>
        <Link className={styles.navCta} href="/dashboard">Open dashboard <ArrowIcon /></Link>
      </header>

      <MarketSnapshotProvider><main>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.kicker}><span /> PAYPAL MARKETS <span className={styles.kickerDivider}>/</span> HACKATHON CONCEPT</p>
            <h1 id="hero-title">A clearer view of crypto, alongside the wallet you already use.</h1>
            <p className={styles.heroText}>Follow market moves, explore useful context, and estimate a portfolio from amounts you enter yourself. Your Venmo wallet stays where it belongs: in Venmo.</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryButton} href="/dashboard">Explore the dashboard <ArrowIcon /></Link>
              <Link className={styles.textLink} href="/dashboard#shop">Discover products <ArrowIcon /></Link>
            </div>
            <div className={styles.heroNote}><span className={styles.noteCheck}>✓</span><span>Market references and manual estimates. No wallet connection or crypto trades.</span></div>
          </div>

          <div className={styles.heroVisual}>
            <div className={styles.visualGlow} />
            <div className={styles.visualTopline}><span className={styles.liveIndicator} /> MARKET SNAPSHOT <span>USD</span></div>
            <LiveMarkets variant="hero" />
            <div className={styles.visualFooter}><span>Source: CoinGecko</span><Link href="/dashboard#markets">View market detail <ArrowIcon /></Link></div>
            <div className={styles.visualWatermark} aria-hidden="true">P</div>
          </div>
        </section>

        <div className={styles.trustStrip}>
          <span>Built around a familiar wallet experience</span>
          <span className={styles.trustDot} />
          <span>Clear market data</span>
          <span className={styles.trustDot} />
          <span>Thoughtful discovery with Channel3</span>
        </div>

        <section id="markets" className={styles.marketSection} aria-labelledby="market-title">
          <div className={styles.sectionIntro}>
            <div><p className={styles.eyebrow}>THE MARKET, IN CONTEXT</p><h2 id="market-title">Know what moved.<br /><span>See the details behind it.</span></h2></div>
            <div className={styles.sectionSide}><p>Market reference prices, useful metrics, and chart history in a single, calm workspace. Follow the seven crypto assets listed in PayPal&apos;s published U.S. supported-assets help page, with the data source and retrieval time in view.</p><Link href="/dashboard#markets" className={styles.inlineLink}>Explore all market views <ArrowIcon /></Link></div>
          </div>
          <LiveMarkets variant="grid" />
          <p className={styles.dataFootnote}>PayPal asset availability varies by country and account type. Prices are references and can differ from payment-provider prices. CoinGecko data may be delayed or unavailable; retrieval time is not the time of each underlying quote.</p>
        </section>

        <section id="experience" className={styles.experienceSection} aria-labelledby="experience-title">
          <div className={styles.sectionIntro}>
            <div><p className={styles.eyebrow}>MADE FOR EVERYDAY CLARITY</p><h2 id="experience-title">A little more signal.<br /><span>And room to make it yours.</span></h2></div>
            <div className={styles.sectionSide}><p>Designed mobile first, then given room to breathe on the web. Each view keeps the important context close and makes the next step clear.</p></div>
          </div>
          <div className={styles.featureGrid}>
            <article className={styles.featureCard}>
              <span className={`${styles.featureIcon} ${styles.iconBlue}`}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 18V6m0 12h16M7 14l4-4 3 2 5-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M16 6h3v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
              <p className={styles.cardIndex}>01 / MARKET VIEW</p><h3>Read the market at a glance.</h3><p>Compare price history, market cap, trading volume, daily range, and watchlist moves without losing track of the source.</p><Link href="/dashboard#overview">Open market overview <ArrowIcon /></Link>
            </article>
            <article className={styles.featureCard}>
              <span className={`${styles.featureIcon} ${styles.iconViolet}`}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Z" stroke="currentColor" strokeWidth="1.6" /><path d="m8 12 2.5 2.5L16.5 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
              <p className={styles.cardIndex}>02 / PERSONAL ESTIMATE</p><h3>Your holdings, on your terms.</h3><p>Enter quantities yourself to see an estimate against market reference prices. Your figures stay in this browser and never represent a Venmo balance.</p><Link href="/dashboard#portfolio">View portfolio tools <ArrowIcon /></Link>
            </article>
            <article className={styles.featureCard}>
              <span className={`${styles.featureIcon} ${styles.iconMint}`}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h14l1.2 12H3.8L5 8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 8V6a4 4 0 0 1 8 0v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M9 13h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>
              <p className={styles.cardIndex}>03 / CHANNEL3 DISCOVERY</p><h3>Find it. Compare it. Save it.</h3><p>Search a wider product catalog, compare retailer offers, and keep useful finds together in collections saved on your device.</p><Link href="/dashboard#shop">Explore Channel3 discovery <ArrowIcon /></Link>
            </article>
          </div>
        </section>

        <section id="discovery" className={styles.discoverySection} aria-labelledby="discovery-title">
          <div className={styles.discoveryCopy}>
            <p className={styles.eyebrow}>A MORE CONSIDERED WAY TO BROWSE</p>
            <h2 id="discovery-title">Start with what you need.<br /><span>Compare before you go.</span></h2>
            <p>Channel3 brings product results and retailer offers into one place to explore. Search to see current results, then follow the retailer link when you are ready to review the details.</p>
            <form className={styles.searchForm} action="/dashboard" method="get">
              <label className={styles.srOnly} htmlFor="home-product-search">Search products</label>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" /><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
              <input id="home-product-search" name="q" type="search" minLength={2} maxLength={120} placeholder="Try “wireless headphones under $150”" />
              <button type="submit">Search products <ArrowIcon /></button>
            </form>
            <p className={styles.searchDisclosure}>Your search phrase is sent to Channel3 to find products. Collections stay in this browser.</p>
          </div>
          <div className={styles.discoveryCard} aria-label="Product discovery flow">
            <div className={styles.discoveryCardTop}><span>01 — DISCOVER</span><span className={styles.channelMark}>C3</span></div>
            <div className={styles.discoveryVisual}>
              <span className={styles.discoveryCircle} /><span className={styles.discoveryOrb} />
              <div className={styles.productTile}><span className={styles.productTileMark}>✳</span><span>Retailer offers</span><span className={styles.productTileLine} /><span className={styles.productTileLineShort} /></div>
              <div className={styles.compareTile}><span className={styles.compareIcon}>↔</span><span>Compare options</span><strong>In one view</strong></div>
            </div>
            <div className={styles.discoveryCardBottom}><span>CURATED FOR YOUR SEARCH</span><span>↗</span></div>
          </div>
        </section>

        <section id="about" className={styles.controlSection} aria-labelledby="control-title">
          <div className={styles.controlMark}><span>PM</span><i /><i /></div>
          <div className={styles.controlCopy}><p className={styles.eyebrow}>CLEAR BY DESIGN</p><h2 id="control-title">Your wallet stays yours.<br /><span>Your data stays understandable.</span></h2><p>This hackathon concept adds market context and product discovery around the wallet experience. It does not connect to Venmo, move money, or trade crypto. Manual portfolio estimates and saved shopping collections are stored locally on this device.</p></div>
          <Link href="/dashboard#settings" className={styles.controlLink}>See data and privacy settings <ArrowIcon /></Link>
        </section>
      </main></MarketSnapshotProvider>

      <footer className={styles.footer}>
        <Link href="/" className={styles.brand}><BrandMark /><span>PayPal <b>Markets</b></span></Link>
        <p>Independent PayPal hackathon concept. Not an official PayPal or Venmo service.</p>
        <Link href="/dashboard">Open dashboard <ArrowIcon /></Link>
      </footer>
    </div>
  );
}
