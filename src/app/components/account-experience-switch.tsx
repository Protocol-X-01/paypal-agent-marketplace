import type { AccountExperience } from "@/lib/account-experience";
import styles from "./account-experience-switch.module.css";

export default function AccountExperienceSwitch({ experience, onChange }: { experience: AccountExperience; onChange: (experience: AccountExperience) => void }) {
  return <section className={styles.experience} aria-labelledby="account-experience-title">
    <div><p className="eyebrow">ACCOUNT EXPERIENCE</p><h2 id="account-experience-title">Make room for your plans.</h2><p>Choose personal planning or your Business workspace. This preview does not connect or change a PayPal account.</p></div>
    <div className={styles.options} role="group" aria-label="Account experience">
      <button type="button" aria-pressed={experience === "personal"} onClick={() => onChange("personal")}><strong>Personal</strong><span>Simple planning &amp; calculators</span></button>
      <button type="button" aria-pressed={experience === "business"} onClick={() => onChange("business")}><strong>Business</strong><span>Reports &amp; activity</span></button>
    </div>
  </section>;
}
