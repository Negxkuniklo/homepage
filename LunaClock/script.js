/**
 * LunaClock - Nonna Edition
 * Core Logic
 */

// Configuration
const LEAP_YEARS = [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29]; // 1-based indices in 30-year cycle
const ISLAMIC_EPOCH_JD = 1507901.25; // 585 BC May 29 (Adjusted +1 Day to align Full Moon)
// Note: May 28 18:00 was 1507900.25. Adjusted to align "Full Moon = Day 15".
const CYCLE_DAYS = 10631; // 30 years * 354 + 11 leap days

class LunaClock {
  constructor() {
    this.svgMoon = document.getElementById("moon-phase");
    this.labelMoon = document.getElementById("moon-label");
    this.timeDisplay = document.getElementById("luna-time");
    this.dateDisplay = document.getElementById("luna-date");
    this.widget = document.querySelector(".luna-widget");

    this.lastDateStr = "";

    this.update();
    setInterval(() => this.update(), 1000); // Update every second
  }

  /* --- Core Calculations --- */

  /**
   * Converts a JS Date object to Julian Day number.
   * Use JST (UTC+9) offset manually since we want JST-based day switch.
   */
  getJD(date) {
    // We want the JD for the given instant.
    // JS Date.getTime() is UTC.
    // JD = (UnixTime_ms / 86400000) + 2440587.5
    return date.getTime() / 86400000 + 2440587.5;
  }

  /**
   * Converts JD to Tabular Islamic Date.
   */
  jdToIslamic(jd) {
    jd = Math.floor(jd) + 0.5; // Round to noon-based JD for integer calculations

    const daysSinceEpoch = Math.floor(jd - ISLAMIC_EPOCH_JD);

    // Cycles
    let cycles = Math.floor(daysSinceEpoch / CYCLE_DAYS);
    let cycleRemainder = daysSinceEpoch % CYCLE_DAYS;
    if (cycleRemainder < 0) {
      // Handle pre-epoch dates if theoretically possible, though unlikely here
      cycles -= 1;
      cycleRemainder += CYCLE_DAYS;
    }

    let year = cycles * 30;
    let days = cycleRemainder;

    // Years within cycle
    let currentYearInCycle = 1;
    while (true) {
      let isLeap = LEAP_YEARS.includes(currentYearInCycle);
      let yearDays = isLeap ? 355 : 354;

      if (days < yearDays) {
        break;
      }

      days -= yearDays;
      year++;
      currentYearInCycle++;
      if (currentYearInCycle > 30) {
        // Should not happen if math is right
        year += currentYearInCycle - 1; // consume remainder
        break;
      }
    }

    year += 1; // Since we started with year = cycles*30

    // Months
    // Odd: 30, Even: 29
    // 12th month: 30 if leap, 29 if not
    let month = 0; // 0-11
    let isLeapYear = LEAP_YEARS.includes(currentYearInCycle); // Re-check for current year

    while (true) {
      let monthDays;
      if (month === 11) {
        // Month 12
        monthDays = isLeapYear ? 30 : 29;
      } else {
        // Month 1, 3, 5... (0, 2, 4...) -> 30
        // Month 2, 4, 6... (1, 3, 5...) -> 29
        monthDays = month % 2 === 0 ? 30 : 29;
      }

      if (days < monthDays) {
        break;
      }

      days -= monthDays;
      month++;
    }

    return {
      year: year,
      month: month + 1, // 1-12
      day: days + 1, // 1-30
      isLeap: isLeapYear,
    };
  }

  /**
   * Calculates the "Luna Time".
   * Rules:
   * - Official Time: JST
   * - Luna Start: 18:00 JST
   * - Luna 00:00 = 18:00 JST (Offset +6 hours)
   * - Date Switch: Happens at 18:00 JST.
   */
  getTimeState() {
    // Get current JST Time.
    // Since the browser environment is running on the User's machine (Check OS info),
    // we can assume `new Date()` reflects the local time.
    // The user prompt says "Daily 18:00 (JST) is date switch".
    // Additional Metadata says "Current local time is...+09:00". So local time IS JST.

    const now = new Date();

    // Calculate Calendar Date
    // If hour >= 18, we are in the "Next Day" for the Lunar Calendar.
    // We add 1 day to the timestamp used for JD conversion.
    const effectiveDate = new Date(now.getTime());
    if (now.getHours() >= 18) {
      effectiveDate.setDate(effectiveDate.getDate() + 1);
    }
    // Note: For JD conversion, we only care about the Date part, not time.
    // JD calculation usually takes noon.
    // We set effectiveDate to Noon of that effective day to be safe.
    effectiveDate.setHours(12, 0, 0, 0);

    const jd = this.getJD(effectiveDate);
    const islamicDate = this.jdToIslamic(jd);

    // Calculate Luna Time
    // Simply add 6 hours to the current time and take Modulo 24.
    // But for display we wrap hours.
    const lunaHours = (now.getHours() + 6) % 24;
    const lunaMinutes = now.getMinutes();
    const lunaSeconds = now.getSeconds();

    return {
      calendar: islamicDate,
      time: { h: lunaHours, m: lunaMinutes, s: lunaSeconds },
    };
  }

  /**
   * Renders a moon phase path for an SVG.
   * Simple terminator simulation.
    /**
     * Renders a moon phase path for an SVG.
     * Simple terminator simulation.
     */
    updateMoonVisual(day) {
        // We want Day 15 to be exactly Full Moon (0.5).
        // Map 1..15 -> 0..0.5
        // Map 15..30 -> 0.5..1.0
        
        // Ensure day is within bounds for safety
        const safeDay = Math.max(1, Math.min(day, 30));

        let phase = 0;
        if (safeDay <= 15) {
            // Waxing
            // Day 1 -> 0
            // Day 15 -> 0.5
            phase = ((safeDay - 1) / 14) * 0.5;
        } else {
            // Waning
            // Day 15 -> 0.5
            // Day 30 -> 1.0 (approx)
            // Range 15..30 has 15 steps.
            phase = 0.5 + ((safeDay - 15) / 15) * 0.5;
        }

        // Clip phase 0..1
        phase = Math.min(1, Math.max(0, phase));

        let d = "";
        
        if (safeDay === 15) {
             // Explicit Full Moon - Draw two semi-circles to make a full circle
             // M 50 5 A 45 45 0 0 1 50 95 A 45 45 0 0 1 50 5
             d = "M 50 5 A 45 45 0 1 1 50 95 A 45 45 0 1 1 50 5";
        } else if (phase <= 0.5) {
            // Waxing
            if (phase < 0.25) {
                // Waxing Crescent
                const bulge = 45 * (1 - (phase/0.25)); 
                d = `M 50 5 A 45 45 0 0 1 50 95 A ${bulge} 45 0 0 0 50 5`; 
            } else {
                // Waxing Gibbous
                const bulge = 45 * ((phase - 0.25)/0.25);
                d = `M 50 5 A 45 45 0 0 1 50 95 A ${bulge} 45 0 0 1 50 5`;
            }
        } else {
            // Waning
            if (phase < 0.75) {
                // Waning Gibbous
                const bulge = 45 * (1 - ((phase-0.5)/0.25)); 
                d = `M 50 5 A 45 45 0 0 0 50 95 A ${bulge} 45 0 0 1 50 5`;
            } else {
                // Waning Crescent
                const pLocal = (phase - 0.75) / 0.25;
                const bulge = 45 * pLocal; 
                d = `M 50 5 A 45 45 0 0 0 50 95 A ${bulge} 45 0 0 0 50 5`;
            }
        }
        
        this.svgMoon.setAttribute('d', d);
        
        // Label Logic
        let label = "";
        if (safeDay === 15) label = "Full Moon";
        else if (safeDay >= 29 || safeDay <= 1) label = "New Moon";
        else if (safeDay < 8) label = "Waxing Crescent";
        else if (safeDay === 8) label = "First Quarter";
        else if (safeDay < 15) label = "Waxing Gibbous";
        else if (safeDay < 22) label = "Waning Gibbous";
        else if (safeDay === 22) label = "Last Quarter";
        else label = "Waning Crescent";
        
        this.labelMoon.textContent = label;
    }

  /* --- Update Loop --- */

  update() {
    const state = this.getTimeState();

    // Format Time: HH:MM:SS
    const pad = (n) => n.toString().padStart(2, "0");
    const timeStr = `${pad(state.time.h)}:${pad(state.time.m)}:${pad(state.time.s)}`;
    this.timeDisplay.textContent = timeStr;

    // Format Date: Year/Month/Day
    const dateStr = `${state.calendar.year}/${pad(state.calendar.month)}/${pad(state.calendar.day)}`;
    this.dateDisplay.textContent = dateStr;

    // Animations
    if (this.lastDateStr && this.lastDateStr !== dateStr) {
      this.triggerDaySwitch();
    }
    this.lastDateStr = dateStr;

    // Moon
    this.updateMoonVisual(state.calendar.day);
  }

  triggerDaySwitch() {
    this.widget.classList.remove("flash-effect");
    void this.widget.offsetWidth; // trigger reflow
    this.widget.classList.add("flash-effect");
  }
}

// Start
document.addEventListener("DOMContentLoaded", () => {
  new LunaClock();
});
