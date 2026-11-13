/*
  BAHAGI firmware · ESP32 in the substation box (Team NEXORA, Meralco IDOL Hackathon 2026)

  SILIP  the HC-SR04 on Pole P1 measures how deep the water is.
  PASYA  at knee level or higher it RECOMMENDS cutting S1 (Estero St.). It never cuts on its own:
         a person approves with the APPROVE button on the lid (or from the dashboard, if Wi-Fi is set up).
  BABALA buzzer + LCD warn on the spot.

  Pins (same as box plan v4 and the hardware test):
    Relays IN1..IN4 = GPIO26, 27, 14, 13  (active LOW: LOW = relay on = street CUT)
    HC-SR04 TRIG = GPIO5, ECHO = GPIO18 (through the 1k/2k divider)
    LCD I2C SDA = GPIO21, SCL = GPIO22 (through the level converter)
    Buzzer + = GPIO25, APPROVE button = GPIO33 to GND

  Button:
    short press  = approve the recommended cut  /  silence the buzzer
    hold 2 s     = restore all streets (only when the water has gone down)
    hold 6 s     = calibrate: "this is dry" (do it with the container empty)

  v5: LCD row 2 shows every relay that is really cut (S1 S2 S3 M1), not just S1.
  v4: LCD search also tries SDA/SCL swapped and prints the I2C line levels + every device it hears.
  v3: LCD is searched again every 5 s if it wasn't found at start.
  v2: dashboard reply parsed strictly (only "cut":["S1",...] counts), LCD found at any I2C address.

  Libraries: "LiquidCrystal I2C" by Frank de Brabander. Board: ESP32 Dev Module (esp32 by Espressif 3.x).
  Wi-Fi is optional: leave WIFI_SSID empty and everything works with the lid button and LCD alone.
*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include <esp_system.h>

// ------------------------------------------------------------------ settings you may change
const char* WIFI_SSID = "BAHAGI";           // the laptop's Windows Mobile Hotspot (2.4 GHz). "" = no Wi-Fi (standalone)
const char* WIFI_PASS = "bahagi2026";
const char* BACKEND   = "auto";             // "auto" = find the laptop by itself (it announces itself on the Wi-Fi)
                                            // or a fixed address like "http://192.168.43.120:8000"
const bool  BUZZER_IS_PASSIVE = false;      // true if your buzzer only clicks with plain power

float DRY_DISTANCE_CM = 22.0;               // sensor to the dry container floor (button-hold 6 s overwrites this)

// water levels on the model's gauge (cm), same as the dashboard (src/config.ts)
const float GUTTER_CM = 1.0, KNEE_CM = 5.0, WAIST_CM = 8.0, CHEST_CM = 11.0;
const float HYSTERESIS_CM = 0.5;            // water must drop this far below a line to count as "below"
const unsigned long CONFIRM_MS = 3000;      // knee level must hold this long before recommending a cut
const unsigned long DRY_MS = 10000;         // water must stay below gutter this long before restore is allowed

// ------------------------------------------------------------------ pins
const int RELAY[4] = {26, 27, 14, 13};
const char* STREET[4] = {"S1 Estero (TR-1)", "S2 Mabini (TR-2)", "S3 Rizal (TR-3)", "S4 house M1 smart meter"};
const int SENSOR_STREET = 0;                // Pole P1 stands on Estero St. (S1)
const int TRIG = 5, ECHO = 18, SDA_PIN = 21, SCL_PIN = 22, BUZZER = 25, BUTTON = 33;

// ------------------------------------------------------------------ state
enum Level { NORMAL, GUTTER, KNEE, WAIST, CHEST };
const char* LEVEL_NAME[] = {"NORMAL", "GUTTER", "KNEE", "WAIST", "CHEST"};

LiquidCrystal_I2C* lcd = nullptr;
Preferences prefs;

bool cut[4] = {false, false, false, false};   // true = that relay is open (power cut). K4 = house M1's smart meter
float depthCm = 0, distanceCm = -1;
bool sensorOk = false;
Level level = NORMAL;
bool pending = false;                         // a cut is recommended and waiting for approval
bool silenced = false;
unsigned long dangerSince = 0, drySince = 0;
bool lidApprovedEvent = false;                // tell the backend the lid button approved
bool lidRestoreEvent = false;
const char* BOOT_REASON = "unknown";            // why the ESP32 last started (sent to the dashboard)
int lastNet = 0;                                // HTTP code of the previous post (200 = got the dashboard's answer)
unsigned long lastReplyMs = 0;                  // how long that answer took

// ------------------------------------------------------------------ relays (fail-safe: lights ON unless told otherwise)
// How the houses are wired to the relays. The built model has the houses on the NO screws (tested: all 4 relay lights
// on = all houses lit; relays off = houses dark), so a house is lit while its relay is pulled in and goes dark when
// the relay is released. If the houses are ever moved to the NC screws, set this to false.
const bool HOUSES_ON_NO = true;
int pinFor(bool cutIt) {                       // relay board input is active LOW (LOW = relay pulled in)
  bool pullIn = HOUSES_ON_NO ? !cutIt : cutIt;
  return pullIn ? LOW : HIGH;
}

void setRelay(int i, bool cutIt) {
  cut[i] = cutIt;
  digitalWrite(RELAY[i], pinFor(cutIt));
  Serial.printf("[RELAY] %s -> %s\n", STREET[i], cutIt ? "CUT (power off)" : "ON");
}

// ------------------------------------------------------------------ buzzer
void buzzOn()  { if (BUZZER_IS_PASSIVE) tone(BUZZER, 2200); else digitalWrite(BUZZER, HIGH); }
void buzzOff() { if (BUZZER_IS_PASSIVE) noTone(BUZZER);     else digitalWrite(BUZZER, LOW); }
void beep(int ms) { buzzOn(); delay(ms); buzzOff(); }

// ------------------------------------------------------------------ sensor
float pingCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000);
  return us == 0 ? -1 : us / 58.0;
}

// median of 3 pings, ignores misses (kept short so button presses aren't missed)
float readDistance() {
  float v[3]; int n = 0;
  for (int i = 0; i < 3; i++) {
    float d = pingCm();
    if (d > 0 && d < 400) v[n++] = d;
    delay(25);
  }
  if (n == 0) return -1;
  for (int i = 1; i < n; i++) for (int j = i; j > 0 && v[j] < v[j - 1]; j--) { float t = v[j]; v[j] = v[j - 1]; v[j - 1] = t; }
  return v[n / 2];
}

Level levelFor(float d, Level prev) {
  // a level is only left when the water drops HYSTERESIS_CM below its line (stops flicker)
  const float lines[] = {0, GUTTER_CM, KNEE_CM, WAIST_CM, CHEST_CM};
  Level l = NORMAL;
  for (int i = 4; i >= 1; i--) if (d >= lines[i]) { l = (Level)i; break; }
  if (l < prev && d > lines[prev] - HYSTERESIS_CM) return prev;
  return l;
}

// ------------------------------------------------------------------ LCD (16x2)
void lcdLine(int row, const String& s) {
  if (!lcd) return;
  String t = s;
  while (t.length() < 16) t += ' ';
  lcd->setCursor(0, row);
  lcd->print(t.substring(0, 16));
}

void showStatus() {
  if (!sensorOk) lcdLine(0, "P1 no echo");
  else lcdLine(0, "P1 " + String(depthCm, 1) + "cm " + LEVEL_NAME[level]);

  // row 2 shows the relays that are ACTUALLY cut right now (all four), not a fixed message
  String off = "";
  const char* SHORT[4] = {"S1", "S2", "S3", "M1"};
  int nOff = 0;
  for (int i = 0; i < 4; i++) if (cut[i]) { if (nOff++) off += " "; off += SHORT[i]; }
  bool dry = drySince && millis() - drySince > DRY_MS;

  if (pending) lcdLine(1, "CUT S1? PRESS OK");
  else if (nOff == 0) lcdLine(1, "All streets ON");
  else if (dry && (millis() / 2000) % 2) lcdLine(1, "Dry:hold=restore");   // alternates with the OFF list
  else if (nOff == 1) lcdLine(1, String(cut[0] ? "S1 Estero" : cut[1] ? "S2 Mabini" : cut[2] ? "S3 Rizal" : "M1 meter") + " OFF");
  else lcdLine(1, "OFF:" + off);
}

// Find the LCD backpack: a PCF8574 (0x20-0x27) or PCF8574A (0x38-0x3F). Tries SDA=D21/SCL=D22 first, then the two
// wires swapped (a common mix-up). Called at start (verbose: prints the line levels and every I2C device it hears)
// and again every 5 s while no screen is found.
void findLcd(bool verbose) {
  const int pins[2][2] = {{SDA_PIN, SCL_PIN}, {SCL_PIN, SDA_PIN}};
  for (int k = 0; k < 2 && !lcd; k++) {
    int sda = pins[k][0], scl = pins[k][1];
    Wire.end();
    pinMode(sda, INPUT_PULLUP); pinMode(scl, INPUT_PULLUP); delay(2);
    int a = digitalRead(sda), b = digitalRead(scl);
    if (verbose && k == 0)
      Serial.printf("[LCD] idle line levels: D%d=%s D%d=%s %s\n", sda, a ? "HIGH" : "LOW", scl, b ? "HIGH" : "LOW",
                    (a && b) ? "(OK)" : "(a LOW line = held to GND: level converter LV not on 3.3V, or a short)");
    if (!(a && b)) continue;               // a stuck line would make every probe wait for a timeout: don't scan
    Wire.begin(sda, scl);
    byte addr = 0;
    for (byte x = 0x08; x <= 0x77; x++) {
      bool lcdRange = (x >= 0x20 && x <= 0x27) || (x >= 0x38 && x <= 0x3F);
      if (!verbose && !lcdRange) continue;  // the 5 s retries only check the 16 LCD addresses (fast)
      Wire.beginTransmission(x);
      if (Wire.endTransmission() == 0) {
        if (verbose) Serial.printf("[LCD] I2C device answers at 0x%02X (SDA=D%d, SCL=D%d)\n", x, sda, scl);
        if (!addr && lcdRange) addr = x;
      }
    }
    if (addr) {
      lcd = new LiquidCrystal_I2C(addr, 16, 2);
      lcd->init(); lcd->backlight(); lcdLine(0, "BAHAGI"); lcdLine(1, "Bahagi lang...");
      Serial.printf("[LCD] found at 0x%02X%s\n", addr,
                    k ? ". NOTE: SDA and SCL wires are swapped; it works anyway" : "");
      return;
    }
  }
  Wire.end();
  Wire.begin(SDA_PIN, SCL_PIN);
  if (verbose) Serial.println("[LCD] no screen on I2C with either wire order (will keep trying every 5 s). "
                              "Check the level converter: LV=3.3V, HV=5V, GND on both sides");
}

// ------------------------------------------------------------------ backend (optional)
// POST {BACKEND}/esp/reading  body: {"poleId":"P1","depthCm":5.1,"distanceCm":16.9,"level":"knee","sensorOk":true,
//                                    "pending":true,"cut":{"S1":false,"S2":false,"S3":false},"lidApproved":false,"lidRestore":false}
// reply (optional):              {"cut":["S1","S4"]} -> relays the dispatcher approved to cut (S4 = M1's smart meter; empty = restore all)
// The backend must apply lidApproved / lidRestore BEFORE building its reply, so a lid approval is never undone.
// If the backend is down, the box keeps working on the lid button alone.
unsigned long lastPost = 0;
String backendUrl = "";                     // filled from BACKEND, or learned from the laptop's announcement
WiFiUDP beacon;
bool beaconOn = false;
int netFails = 0;

// The backend shouts "BAHAGI:8000" to the whole Wi-Fi every 2 s (UDP port 4210). We take the sender's address.
void findBackend() {
  if (strcmp(BACKEND, "auto") != 0) { backendUrl = BACKEND; return; }
  if (WiFi.status() != WL_CONNECTED) return;
  static unsigned long listenSince = 0;
  if (!beaconOn) { beacon.begin(4210); beaconOn = true; Serial.println("[NET] looking for the BAHAGI laptop..."); }
  if (backendUrl.length() == 0 && listenSince == 0) listenSince = millis();
  int n = beacon.parsePacket();
  if (n <= 0) {
    // no announcement heard: on a Windows Mobile Hotspot the laptop IS the gateway (192.168.137.1), so try it
    if (backendUrl.length() == 0 && listenSince && millis() - listenSince > 6000) {
      backendUrl = "http://" + WiFi.gatewayIP().toString() + ":8000";
      listenSince = 0;
      Serial.println("[NET] no announcement heard, trying the hotspot gateway " + backendUrl);
    }
    return;
  }
  listenSince = 0;
  char buf[32] = {0};
  beacon.read(buf, sizeof(buf) - 1);
  if (strncmp(buf, "BAHAGI:", 7) != 0) return;
  String url = "http://" + beacon.remoteIP().toString() + ":" + String(atoi(buf + 7));
  if (url != backendUrl) {
    backendUrl = url;
    netFails = 0;
    Serial.println("[NET] found the backend at " + backendUrl);
  }
}

void postReading() {
  if (strlen(WIFI_SSID) == 0 || WiFi.status() != WL_CONNECTED) return;
  findBackend();
  if (backendUrl.length() == 0) return;
  if (millis() - lastPost < 2000) return;
  lastPost = millis();

  const char* lv[] = {"normal", "gutter", "knee", "waist", "chest"};
  char body[480];
  snprintf(body, sizeof(body),
           "{\"poleId\":\"P1\",\"depthCm\":%.1f,\"distanceCm\":%.1f,\"level\":\"%s\",\"sensorOk\":%s,\"pending\":%s,"
           "\"cut\":{\"S1\":%s,\"S2\":%s,\"S3\":%s,\"S4\":%s},\"lidApproved\":%s,\"lidRestore\":%s,"
           "\"uptimeS\":%lu,\"rssi\":%d,\"lcdOk\":%s,\"dryCm\":%.1f,\"boot\":\"%s\",\"net\":%d,\"replyMs\":%lu}",
           depthCm, distanceCm, lv[level], sensorOk ? "true" : "false", pending ? "true" : "false",
           cut[0] ? "true" : "false", cut[1] ? "true" : "false", cut[2] ? "true" : "false", cut[3] ? "true" : "false",
           lidApprovedEvent ? "true" : "false", lidRestoreEvent ? "true" : "false",
           (unsigned long)(millis() / 1000), (int)WiFi.RSSI(), lcd ? "true" : "false", DRY_DISTANCE_CM, BOOT_REASON,
           lastNet, lastReplyMs);

  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(5000);                        // a slow laptop answer used to be dropped after 1.5 s
  http.begin(backendUrl + "/esp/reading");
  http.addHeader("Content-Type", "application/json");
  unsigned long t0 = millis();
  int code = http.POST(body);
  lastReplyMs = millis() - t0;
  lastNet = code;
  if (code == 200) {
    netFails = 0;
    lidApprovedEvent = lidRestoreEvent = false;
    String reply = http.getString();
    static String lastReply = "";
    if (reply != lastReply) { Serial.println("[NET] dashboard says: " + reply); lastReply = reply; }
    // only follow  "cut": [ ... ]  (anything else that happens to be named "cut" is ignored)
    int k = reply.indexOf("\"cut\"");
    int a = -1, b = -1;
    if (k >= 0) {
      int p = k + 5;
      while (p < (int)reply.length() && (reply[p] == ' ' || reply[p] == ':')) p++;
      if (p < (int)reply.length() && reply[p] == '[') { a = p; b = reply.indexOf(']', a); }
    }
    if (a >= 0 && b > a) {                      // follow the dispatcher's decision from the dashboard
      String list = reply.substring(a + 1, b);
      for (int i = 0; i < 4; i++) {             // S1-S3 transformers, S4 = M1's smart meter
        bool want = list.indexOf(String("\"S") + (i + 1) + "\"") >= 0;   // exact "S2", with the quotes
        if (want != cut[i]) {
          Serial.printf("[NET] dashboard wants %s -> %s\n", STREET[i], want ? "CUT" : "ON");
          setRelay(i, want);
          if (want && i == SENSOR_STREET) pending = false;   // only an S1 cut answers the S1 recommendation
        }
      }
    }
  } else {
    Serial.printf("[NET] backend not reachable (%d), running on the lid button\n", code);
    if (++netFails >= 3 && strcmp(BACKEND, "auto") == 0) backendUrl = "";   // laptop moved? listen again
  }
  http.end();
}

// ------------------------------------------------------------------ button
unsigned long pressedAt = 0;
bool wasPressed = false, longDone = false;

void calibrate() {
  lcdLine(0, "Calibrating...");
  lcdLine(1, "keep it dry");
  float d = readDistance();
  if (d > 0) {
    DRY_DISTANCE_CM = d;
    prefs.putFloat("dry", d);
    Serial.printf("[CAL] dry distance = %.1f cm (saved)\n", d);
    lcdLine(1, "dry=" + String(d, 1) + "cm saved");
    beep(80); delay(80); beep(80);
  } else {
    lcdLine(1, "no echo, failed");
    beep(600);
  }
  delay(1500);
}

void handleButton() {
  bool p = digitalRead(BUTTON) == LOW;
  unsigned long now = millis();
  if (p && !wasPressed) { pressedAt = now; longDone = false; }

  if (p && !longDone && now - pressedAt > 6000) {           // hold 6 s: calibrate
    longDone = true;
    calibrate();
  }

  if (!p && wasPressed && !longDone) {
    unsigned long held = now - pressedAt;
    if (held >= 2000) {                                      // hold 2 s: restore (only when it's dry)
      bool dry = drySince && now - drySince > DRY_MS;
      if (dry) {
        for (int i = 0; i < 4; i++) if (cut[i]) setRelay(i, false);
        lidRestoreEvent = true;
        Serial.println("[LID] restore approved on the lid");
        beep(60); delay(60); beep(60);
      } else {
        Serial.println("[LID] restore refused: water not down for 10 s yet");
        beep(400);
      }
    } else if (held > 40) {                                  // short press
      if (pending) {
        setRelay(SENSOR_STREET, true);
        pending = false;
        lidApprovedEvent = true;
        Serial.println("[LID] cut approved on the lid");
        beep(150);
      }
      silenced = true;
      buzzOff();
    }
  }
  wasPressed = p;
}

// ------------------------------------------------------------------ setup / loop
void setup() {
  // all streets ON first. pinMode must come BEFORE digitalWrite: on ESP32 core 3.x a write to a pin that isn't an
  // output yet is ignored, and the pin then starts LOW = every relay pulled in.
  for (int i = 0; i < 4; i++) { pinMode(RELAY[i], OUTPUT); digitalWrite(RELAY[i], pinFor(false)); }
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  pinMode(BUZZER, OUTPUT); buzzOff();
  pinMode(BUTTON, INPUT_PULLUP);

  // relay check at every start: K1, K2, K3, K4 click once each, in order (each street's houses blink off once). A relay that stays silent = its IN wire
  // isn't on the right ESP32 pin (IN1 D26, IN2 D27, IN3 D14, IN4 D13) or the relay board has no power.
  for (int i = 0; i < 4; i++) {
    Serial.printf("[TEST] relay K%d (pin %d)\n", i + 1, RELAY[i]);
    digitalWrite(RELAY[i], pinFor(true));  delay(400);   // that street's houses blink off once
    digitalWrite(RELAY[i], pinFor(false)); delay(200);
  }

  Serial.begin(115200);
  switch (esp_reset_reason()) {                 // a brownout = the power supply dipped (too much load on USB)
    case ESP_RST_POWERON:  BOOT_REASON = "power_on"; break;
    case ESP_RST_BROWNOUT: BOOT_REASON = "brownout"; break;
    case ESP_RST_PANIC:    BOOT_REASON = "crash"; break;
    case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: BOOT_REASON = "watchdog"; break;
    case ESP_RST_SW:       BOOT_REASON = "software"; break;
    case ESP_RST_EXT:      BOOT_REASON = "reset_button"; break;
    default:               BOOT_REASON = "other"; break;
  }
  Serial.printf("[BOOT] reason: %s\n", BOOT_REASON);
  delay(300);
  Serial.println("\n=== BAHAGI · Bahagi lang, hindi buong barangay ===");

  prefs.begin("bahagi", false);
  DRY_DISTANCE_CM = prefs.getFloat("dry", DRY_DISTANCE_CM);
  Serial.printf("[CAL] dry distance %.1f cm (hold the button 6 s with the container empty to recalibrate)\n", DRY_DISTANCE_CM);

  Wire.begin(SDA_PIN, SCL_PIN);
  findLcd(true);

  if (strlen(WIFI_SSID)) {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);                       // answer fast: no Wi-Fi power saving
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("[NET] connecting to %s", WIFI_SSID);
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print('.'); }
    Serial.println(WiFi.status() == WL_CONNECTED ? " ok, IP " + WiFi.localIP().toString() : " failed, running standalone");
  }
  beep(80);
  delay(800);
}

unsigned long lastRead = 0, lastLog = 0, lastChirp = 0, lastLcdTry = 0;

void loop() {
  unsigned long now = millis();
  handleButton();

  if (now - lastRead >= 500) {
    lastRead = now;
    distanceCm = readDistance();
    sensorOk = distanceCm > 0;
    if (sensorOk) {
      depthCm = max(0.0f, DRY_DISTANCE_CM - distanceCm);
      level = levelFor(depthCm, level);
    }

    // PASYA: recommend a cut when knee level holds for CONFIRM_MS (never cut without approval)
    bool danger = sensorOk && level >= KNEE;
    if (danger) {
      if (!dangerSince) dangerSince = now;
      if (!cut[SENSOR_STREET] && !pending && now - dangerSince >= CONFIRM_MS) {
        pending = true;
        silenced = false;
        Serial.printf("[PASYA] %.1f cm (%s) at P1 -> recommend cutting %s. Waiting for APPROVE.\n",
                      depthCm, LEVEL_NAME[level], STREET[SENSOR_STREET]);
      }
    } else {
      dangerSince = 0;
      if (pending) { pending = false; Serial.println("[PASYA] water went down, recommendation withdrawn"); }
    }

    // dry timer for restore
    if (sensorOk && depthCm < GUTTER_CM - HYSTERESIS_CM / 2) { if (!drySince) drySince = now; }
    else drySince = 0;

    showStatus();
    for (int i = 0; i < 4; i++) digitalWrite(RELAY[i], pinFor(cut[i]));   // keep every relay pin where it should be
  }

  // BABALA: chirp while a cut is waiting for approval (button silences)
  if (pending && !silenced && now - lastChirp > 1500) { lastChirp = now; beep(120); }

  if (now - lastLog >= 1000) {
    lastLog = now;
    if (sensorOk) Serial.printf("P1 distance %.1f cm | depth %.1f cm | %s | S1 %s S2 %s S3 %s%s\n",
                                distanceCm, depthCm, LEVEL_NAME[level],
                                cut[0] ? "CUT" : "on", cut[1] ? "CUT" : "on", cut[2] ? "CUT" : "on",
                                pending ? " | WAITING FOR APPROVE" : "");
    else Serial.println("P1 no echo (check sensor wiring)");
  }

  if (!lcd && now - lastLcdTry >= 5000) { lastLcdTry = now; findLcd(false); }

  postReading();
}
