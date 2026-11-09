import styles from './paypal-plus-guide.module.css';

const PAYPAL_PLUS_URL = 'https://www.paypal.com/uk/digital-wallet/paypal-plus-loyalty-programme?locale.x=en_GB';

export default function PayPalPlusGuide() {
  return (
    <section className={styles.panel} aria-labelledby="paypal-plus-guide-title">
      <div className={styles.main}>
        <span className={styles.eyebrow}>PAYPAL+ · UK REWARDS</span>
        <h3 id="paypal-plus-guide-title">Points belong at PayPal checkout.</h3>
        <p>Explore the UK programme, then check your live balance, tier, benefits and eligible offers in PayPal.</p>
        <a className={styles.link} href={PAYPAL_PLUS_URL} target="_blank" rel="noreferrer">Explore PayPal+ at PayPal <span aria-hidden="true">↗</span></a>
      </div>
      <div className={styles.boundary}>
        <strong>Rewards and shopping offers are different</strong>
        <p>This concept cannot read or redeem PayPal+ points. Channel3’s advertised affiliate commission is not customer cashback or points, and a retailer handoff may not use PayPal checkout.</p>
      </div>
    </section>
  );
}
