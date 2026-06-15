---
name: roblox-game-design
description: >
  คู่มือออกแบบเกม Roblox ระดับมืออาชีพ ครอบคลุม game concept, game design document (GDD),
  core loop, progression system, economy design, player experience และ monetization strategy.
  ใช้ทักษะนี้ทุกครั้งที่ผู้ใช้ถามเกี่ยวกับ "อยากสร้างเกมแบบไหนดี", "เกมของฉันน่าเล่นไหม",
  "ออกแบบระบบ X ยังไง", "เกมควรมีอะไรบ้าง", "core loop คืออะไร", "จะทำให้คนติดเกมได้ยังไง"
  หรือขอความช่วยเหลือด้าน concept, design document, ระบบ progression, economy หรือ player retention
  ใน Roblox แม้จะไม่ได้พูดถึงการเขียนโค้ดก็ตาม
---

# Roblox Game Design Skill

เป้าหมาย: ช่วยออกแบบเกม Roblox ให้น่าเล่น มี direction ชัดเจน และมีโอกาสประสบความสำเร็จ

---

## 1. กระบวนการออกแบบ (Design Process)

```
Concept → Core Loop → Systems → Economy → Progression → Monetization → Polish
```

ทำตามลำดับนี้ — อย่าเริ่มเขียนโค้ดก่อนที่ Core Loop จะชัดเจน

---

## 2. Game Concept (แนวคิดเกม)

### คำถามที่ต้องตอบให้ได้ก่อนสร้างเกม

| คำถาม | ตัวอย่างคำตอบ |
|--------|--------------|
| เกมประเภทอะไร? | Obby / RPG / Simulator / FPS / Tycoon / Horror |
| ผู้เล่นคือใคร? | เด็ก 8-12 ปี / วัยรุ่น / กลุ่มเพื่อน |
| ทำไมคนจะเล่น? | ความสนุก / ความท้าทาย / การแข่งขัน / การสะสม |
| จุดขายคืออะไร? | สิ่งที่ทำให้ต่างจากเกมอื่น |
| เล่นคนเดียวหรือหลายคน? | Solo / Co-op / PvP / MMO |

### Template: One-Line Concept
```
[เกมประเภท] ที่ผู้เล่น [ทำอะไร] เพื่อ [เป้าหมาย]
โดยมีจุดเด่นคือ [สิ่งที่ทำให้แตกต่าง]

ตัวอย่าง:
"RPG ที่ผู้เล่นสำรวจดันเจี้ยนร่วมกับเพื่อน 4 คน
เพื่อเอาชนะ boss และ craft อาวุธหายาก
โดยมีระบบ class ที่เปลี่ยนได้ตลอดเวลา"
```

---

## 3. Core Loop (วงจรหลักของเกม)

Core Loop คือสิ่งที่ผู้เล่นทำซ้ำๆ ตลอดเวลา — ถ้า loop น่าเบื่อ เกมจะล้มเหลว

### โครงสร้าง Core Loop ที่ดี
```
Action → Reward → Upgrade → Action (ยากขึ้น) → ...
```

### ตัวอย่างตาม genre

**Simulator:**
```
เก็บของ → ขายของ → ซื้อ upgrade → เก็บของได้เร็วขึ้น
```

**RPG/Combat:**
```
ต่อสู้ศัตรู → รับ EXP/ไอเทม → Level up/craft → ต่อสู้ศัตรูแรงขึ้น
```

**Tycoon:**
```
สร้าง building → passive income → ซื้อ building ใหม่ → ขยาย empire
```

**Obby:**
```
วิ่งผ่าน stage → ปลดล็อก stage ถัดไป → ท้าทายขึ้น → ถึงจุดสิ้นสุด
```

### วิธีทดสอบ Core Loop
ถามตัวเองว่า: "ถ้าเอาทุกอย่างออกหมด เหลือแค่ loop นี้ คนจะยังเล่นอยู่ไหม?"
ถ้าตอบ "ไม่" → loop ยังไม่แข็งแกร่งพอ

---

## 4. Progression System (ระบบความก้าวหน้า)

### สี่แกนหลักของ Progression

```
1. POWER      — ตัวละครแรงขึ้น (stats, abilities)
2. CONTENT    — เนื้อหาใหม่ปลดล็อก (areas, quests, items)
3. COSMETIC   — หน้าตาสวยขึ้น (skins, effects, accessories)
4. SOCIAL     — สถานะในหมู่เพื่อน (rank, title, leaderboard)
```

เกมที่ดีควรมีอย่างน้อย 2-3 แกน เพื่อดึงดูดผู้เล่นหลายประเภท

### Progression Curve
- เริ่มต้นง่าย: ให้ผู้เล่นรู้สึก "เก่ง" ก่อน
- ค่อยๆ ยากขึ้น: อย่า spike กะทันหัน
- มี milestone ทุก 5-10 เลเวล: เพื่อให้รู้สึกถึงความก้าวหน้า

---

## 5. Game Economy (ระบบเศรษฐกิจในเกม)

### ประเภท Currency
```
Hard Currency  — ซื้อด้วยเงินจริง, หายาก (Robux / Premium coins)
Soft Currency  — หาได้จากการเล่น, ใช้ทั่วไป (Gold, Coins)
Event Currency — หาได้จาก event พิเศษ (Stars, Tokens)
```

### กฎสมดุล Economy
- **Income** (รายได้จาก gameplay, quests, daily bonuses)
- **Sinks** (ทางใช้เงิน: upgrades, cosmetics, crafting)
- กฎ: Sinks ควรมีมากกว่า Income เล็กน้อย → เงินมีคุณค่า, ผู้เล่นต้องเลือก

### Anti-Patterns ที่ควรหลีกเลี่ยง
- **Inflation:** มีเงินมากเกินใช้ → ไอเทมไม่มีคุณค่า
- **Pay-to-Win:** ซื้อเงินจริงแล้วแรงกว่ามาก → คนเลิกเล่น
- **Dead End:** ไม่รู้จะใช้เงินทำอะไร → ไม่มีแรงจูงใจเล่นต่อ

---

## 6. Player Retention (การรักษาผู้เล่น)

### Daily Engagement Hooks
- Daily Login Reward — รับของทุกวันที่ login
- Daily Quests — ภารกิจใหม่ทุกวัน
- Timed Events — event จำกัดเวลา สร้าง FOMO
- Leaderboard Reset — รีเซ็ตทุกอาทิตย์ ให้คนแข่งกันใหม่
- Seasonal Content — เนื้อหาตามฤดูกาล/วันหยุด

### Session Length Design
| ประเภทเกม | Session ที่เหมาะสม |
|-----------|------------------|
| Idle/Simulator | 5-15 นาที |
| Obby | 10-20 นาที |
| RPG/Adventure | 20-45 นาที |
| Competitive | 5-15 นาที (จบ match) |

---

## 7. Game Design Document (GDD) Template

เมื่อผู้ใช้ขอสร้าง GDD ให้ใช้ template นี้:

```markdown
# [ชื่อเกม] — Game Design Document

## Overview
- ประเภทเกม:
- จำนวนผู้เล่น: X-Y คนต่อ server
- เป้าหมายผู้เล่น: (อายุ/กลุ่ม)
- One-Line Concept:

## Core Loop
[อธิบาย loop หลัก]

## Game Pillars (3 สิ่งที่เกมนี้เน้น)
1. [Pillar 1]
2. [Pillar 2]
3. [Pillar 3]

## Systems Overview
- Combat / Progression / Inventory / Economy / UI / Social

## Monetization
- Free Content:
- Game Passes:
- Developer Products:

## Milestones
- Week 1-2: Core Loop prototype
- Week 3-4: Basic progression
- Week 5-6: Polish + Beta
- Launch: [วันที่]
```

---

## 8. วิธีตอบสนองต่อคำขอออกแบบ

1. ถามถึง **target audience** ก่อนเสมอถ้าไม่ชัดเจน
2. ให้ **ตัวเลือก 2-3 แนวทาง** พร้อม trade-off
3. ยกตัวอย่าง **เกม Roblox ยอดนิยม** ที่ใช้ pattern คล้ายกัน
4. เตือน **anti-patterns** ที่ทำให้เกมล้มเหลว
5. สร้าง **GDD draft** ถ้าผู้ใช้มี concept พร้อม

---

## Reference Files
- `references/genre-patterns.md` — Pattern เฉพาะตาม genre (RPG, Simulator, Obby ฯลฯ)
