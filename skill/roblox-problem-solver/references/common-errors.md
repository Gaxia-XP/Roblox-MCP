# Common Errors — Roblox

## Script Errors

| Error Message | สาเหตุ | วิธีแก้ |
|--------------|--------|--------|
| `attempt to index nil value` | ตัวแปรเป็น nil | ใช้ FindFirstChild + nil check |
| `attempt to call a nil value` | เรียก function ที่ไม่มี | ตรวจว่า module return ถูกต้อง |
| `Script timeout` | loop ไม่มี yield | เพิ่ม task.wait() |
| `Unknown global 'X'` | ชื่อตัวแปรผิด | ตรวจการสะกด, ใช้ local |
| `Stack overflow` | recursion ไม่มีจุดหยุด | เพิ่ม base case |
| `bad argument #1` | ส่ง type ผิดให้ function | ตรวจ type ก่อนส่ง |

---

## DataStore Errors

| Error | สาเหตุ | วิธีแก้ |
|-------|--------|--------|
| `HTTP 403` | ไม่ได้เปิด API access | Game Settings → Enable Studio API |
| `Request throttled` | เรียกบ่อยเกินไป | เพิ่ม cooldown, ใช้ cache |
| `Value too large` | data เกิน 4MB | compress หรือแยก key |
| `Key too long` | key เกิน 50 ตัวอักษร | ย่อ key |

---

## RemoteEvent Problems

| อาการ | สาเหตุ | วิธีแก้ |
|-------|--------|--------|
| Server ไม่รับ event | FireServer จาก Script (ไม่ใช่ LocalScript) | ย้ายไป LocalScript |
| Client ไม่รับ event | FireClient ไม่ได้ส่ง player argument | เพิ่ม player เป็น argument แรก |
| Remote หาไม่เจอ | ชื่อผิด หรือ path ผิด | ตรวจ path ใน ReplicatedStorage |
| Event ยิงแต่ไม่ทำงาน | Connect ช้ากว่า Fire | ใช้ BindableEvent หรือรอ player ready |

---

## Physics / Movement

| อาการ | สาเหตุ | วิธีแก้ |
|-------|--------|--------|
| Part ตกทะลุพื้น | Velocity สูง + thin floor | เพิ่ม thickness พื้น / ใช้ CFrame แทน Velocity |
| Character ติด geometry | Collision ซับซ้อน | simplify collision box |
| NPC ค้างอยู่กับที่ | Path blocked | เพิ่ม pathfinding retry logic |
| Humanoid ไม่ขยับ | WalkSpeed = 0 | ตรวจ WalkSpeed และ JumpPower |
