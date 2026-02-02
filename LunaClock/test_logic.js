
// Test Script for LunaClock Logic

const LEAP_YEARS = [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29];
const ISLAMIC_EPOCH_JD = 1948439.5; 
const CYCLE_DAYS = 10631; 

function getJD(date) {
    return (date.getTime() / 86400000) + 2440587.5;
}

function jdToIslamic(jd) {
    jd = Math.floor(jd) + 0.5;
    const daysSinceEpoch = Math.floor(jd - ISLAMIC_EPOCH_JD);
    let cycles = Math.floor(daysSinceEpoch / CYCLE_DAYS);
    let cycleRemainder = daysSinceEpoch % CYCLE_DAYS;
    if (cycleRemainder < 0) { cycles -= 1; cycleRemainder += CYCLE_DAYS; }

    let year = cycles * 30;
    let days = cycleRemainder;
    let currentYearInCycle = 1;
    while (true) {
        let isLeap = LEAP_YEARS.includes(currentYearInCycle);
        let yearDays = isLeap ? 355 : 354;
        if (days < yearDays) break;
        days -= yearDays;
        year++;
        currentYearInCycle++;
        if (currentYearInCycle > 30) { year += (currentYearInCycle - 1); break; }
    }
    year += 1;
    let month = 0;
    let isLeapYear = LEAP_YEARS.includes(currentYearInCycle);
    while (true) {
        let monthDays;
        if (month === 11) monthDays = isLeapYear ? 30 : 29;
        else monthDays = (month % 2 === 0) ? 30 : 29;
        if (days < monthDays) break;
        days -= monthDays;
        month++;
    }
    return { year: year, month: month + 1, day: days + 1 };
}

function test(dateStr) {
    const d = new Date(dateStr);
    const jd = getJD(d);
    const islamic = jdToIslamic(jd);
    console.log(`Date: ${dateStr} -> JD: ${jd.toFixed(2)} -> Islamic: ${islamic.year}/${islamic.month}/${islamic.day}`);
}

console.log("--- Testing Known Dates ---");
// Epoch: July 16, 622 -> Should be 1/1/1
test("622-07-16T12:00:00Z"); 

// Today: 2026-02-02
test("2026-02-02T12:00:00+09:00"); 

console.log("\n--- Testing 18:00 Switch Logic ---");
// 2026-02-02 17:59 (JST)
const before = new Date("2026-02-02T17:59:00+09:00");
// 2026-02-02 18:00 (JST) -> Should be next day
const after = new Date("2026-02-02T18:01:00+09:00");

function getEffectiveIslamicDate(date) {
     const effectiveDate = new Date(date.getTime());
    if (date.getHours() >= 18) {
        effectiveDate.setDate(effectiveDate.getDate() + 1);
    }
    effectiveDate.setHours(12, 0, 0, 0);
    return jdToIslamic(getJD(effectiveDate));
}

const iBefore = getEffectiveIslamicDate(before);
const iAfter = getEffectiveIslamicDate(after);

console.log(`17:59 -> ${iBefore.year}/${iBefore.month}/${iBefore.day}`);
console.log(`18:01 -> ${iAfter.year}/${iAfter.month}/${iAfter.day}`);

console.log("\n--- Testing Luna Time ---");
function getLunaTime(date) {
    return (date.getHours() + 6) % 24;
}
console.log(`18:00 JST -> Luna Hour: ${getLunaTime(new Date("2026-02-02T18:00:00"))}`);
console.log(`00:00 JST -> Luna Hour: ${getLunaTime(new Date("2026-02-03T00:00:00"))}`);
