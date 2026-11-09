import type { AccountExperience } from "@/lib/account-experience";
import styles from "./account-experience-switch.module.css";

export default function AccountExperienceSwitch({ experience, onChange }: { experience: AccountExperience; onChange: (experience: AccountExperience) => void }) {
  return <section className={styles.experience} aria-labelledby="account-experience-title">
    <div><p className="eyebrow">ACCOUNT EXPERIENCE</p><h2 id="account-experience-title">Make room for your plans.</h2></div>
    <div className={styles.options} role="group" aria-label="Account experience">
      <button type="button" aria-pressed={experience === "personal"} onClick={() => onChange("personal")}><strong>Personal Lite</strong></button>
      <button type="button" aria-pressed={experience === "business"} onClick={() => onChange("business")}><strong>Business preview</strong></button>
    </div>
  </section>;
}
