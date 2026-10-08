# **PROJECT HUB 2.0**

## **Master Product, UX, Architecture & Automation Specification**

**Doküman Tipi:** Ana Ürün ve Teknik Şartname  
**Hedef:** Şirket içi projelerin merkezi yönetimi, geliştirilmesi, ön izlenmesi, test edilmesi, yayınlanması, arşivlenmesi ve AI ile yönetilmesi  
**Başlangıç Altyapısı:** 8 GB RAM / 200 GB Disk  
**Ana Database:** PostgreSQL  
**Çalışma Modeli:** Web tabanlı merkezi sistem \+ opsiyonel Windows/macOS Local Agent  
**Uzun Vadeli Vizyon:** Project Hub / Development Operating System / AI Engineering Platform

---

# **1\. ÜRÜNÜN ANA VİZYONU**

Project Hub yalnızca projelerin tutulduğu bir yönetim paneli olmayacaktır.

Sistem;

* Şirketin bütün projelerini merkezi olarak saklayacak,  
* Kaynak kodlarını yönetecek,  
* Projeleri analiz edecek,  
* Hangi teknolojiyle geliştirildiğini anlayacak,  
* Build alacak,  
* Test çalıştıracak,  
* Preview ortamı oluşturacak,  
* Mobil/desktop simülasyonu yapacak,  
* Geçici müşteri bağlantıları oluşturacak,  
* Müşteri feedbacklerini toplayacak,  
* Deployment yapacak,  
* Versiyon yönetecek,  
* Database migrationlarını takip edecek,  
* Güvenlik taraması yapacak,  
* Proje loglarını izleyecek,  
* Teknik borçları takip edecek,  
* AI ile proje hakkında bilgi verecek,  
* Kontrollü olarak kod değişikliği hazırlayacak,  
* İlerleyen fazlarda belirli operasyonları otomatik gerçekleştirecek

merkezi bir platform olacaktır.

Nihai hedef:

**Project Hub'ın şirketin teknik hafızası ve yazılım operasyon merkezi haline gelmesidir.**

---

# **2\. TEMEL PRENSİP**

Sistemde şu problem ortadan kaldırılacaktır:

> “Proje Ahmet'in bilgisayarında.”

> “Dosyalar bende.”

> “Son versiyon kimde?”

> “Müşteriye hangi demo gönderildi?”

> “Production'daki kod hangisi?”

> “Bu değişikliği kim yaptı?”

> “Database'i güncellersek veri gider mi?”

Project Hub yaklaşımı:

**Proje kişiye değil organizasyona ait olacaktır.**

Ana proje kaynağı merkezi sistemde bulunacaktır.

Developer bilgisayarları çalışma aracı olacaktır; ana kaynak olmayacaktır.

---

# **3\. ÜRÜNÜN 4 ANA ARAYÜZÜ**

Project Hub aslında dört farklı kullanıcı deneyiminden oluşacaktır.

## **A. Administration Control Center**

Sistem yöneticilerinin kullandığı alan.

Buradan:

* Kullanıcılar  
* Yetkiler  
* Organizasyon  
* Projeler  
* Sunucular  
* Storage  
* AI kullanımı  
* Güvenlik politikaları  
* Deployment politikaları  
* Audit kayıtları  
* Integrationlar

yönetilir.

---

## **B. Project Workspace**

Developer, designer, QA ve project manager'ın günlük kullandığı ana çalışma alanıdır.

Buradan:

* Kod  
* Branch  
* Commit  
* Build  
* Preview  
* Simulator  
* Deployment  
* Version  
* Feedback  
* AI  
* Security  
* Logs  
* Database  
* Documentation

yönetilir.

---

## **C. Customer Review Portal**

Müşteriye gönderilen geçici bağlantının açıldığı sade arayüzdür.

Müşteri:

* Projeyi görür,  
* Cihaz görünümünü değiştirir,  
* Sayfanın üzerine feedback bırakır,  
* Screenshot üzerinden yorum yapar,  
* Yorumları takip eder,  
* Gerekirse ekip ile mesajlaşır.

Müşterinin Project Hub hesabına sahip olması gerekmez.

---

## **D. Project Hub Local Agent**

Windows ve macOS bilgisayarlara kurulabilecek yardımcı uygulamadır.

Ana sistemin local bilgisayarda yetkili işlemler gerçekleştirmesini sağlar.

Örneğin:

* Local klasörü Project Hub'a aktar  
* Local simulator aç  
* Local browser test çalıştır  
* Belirli klasörü senkronize et  
* IDE aç  
* Remote workspace bağla

Ancak bilgisayarın tamamına sınırsız erişim verilmez.

---

# **4\. SİSTEMİN ANA MİMARİSİ**

İlk aşamada gereksiz karmaşıklıktan kaçınılacaktır.

Başlangıç mimarisi:

                   INTERNET  
                       │  
                Reverse Proxy  
                       │  
         ┌─────────────┴─────────────┐  
         │                           │  
    Project Hub UI              Review Portal  
         │                           │  
         └─────────────┬─────────────┘  
                       │  
                 Project Hub API  
                       │  
      ┌────────────────┼───────────────────┐  
      │                │                   │  
 PostgreSQL          Redis             Worker Queue  
      │                                    │  
      │                  ┌─────────────────┼─────────────┐  
      │                  │                 │             │  
      │                Build           Preview         AI  
      │                Worker          Worker         Worker  
      │                  │                 │             │  
      │                Docker            Docker       AI API  
      │  
      ├── Forgejo / Git  
      │  
      ├── Artifact Storage  
      │  
      ├── Backup Storage  
      │  
      └── Audit Logs

İlk aşamada mimari:

**Modüler Monolith \+ Background Workers**

olacaktır.

Sistem büyüdüğünde modüller mikroservislere ayrılabilecektir.

---

# **5\. ANA BACKEND MODÜLLERİ**

Backend aşağıdaki domainlere ayrılacaktır.

| Modül | Görev |
| ----- | ----- |
| Auth | Login, session, authentication |
| Organization | Organizasyon yönetimi |
| User | Kullanıcı yönetimi |
| IAM | Rol ve yetki |
| Project | Proje temel bilgileri |
| Repository | Git işlemleri |
| Source Intelligence | Kod yapısını anlama |
| Build | Build süreçleri |
| Preview | Preview oluşturma |
| Simulator | Device simulator |
| Environment | Dev/Staging/Production |
| Deployment | Deployment |
| Version | Versiyon yönetimi |
| Update | Upgrade/migration |
| Database | DB bağlantıları |
| Secret | Güvenli credential yönetimi |
| Review | Müşteri review session |
| Feedback | Feedback yönetimi |
| AI | AI orchestrator |
| Security | Güvenlik taraması |
| Artifact | Build dosyaları |
| Storage | Dosya depolama |
| Monitoring | Metric/log/trace |
| Notification | Bildirim sistemi |
| Audit | İşlem geçmişi |
| Agent | Windows/macOS agent |
| Integration | Harici entegrasyonlar |
| Workflow | Uzun süreli işlemler |

---

# **6\. ÖNERİLEN TEKNOLOJİ YAPISI**

## **Frontend**

**Next.js \+ TypeScript**

UI component sistemi reusable olacaktır.

---

## **Backend**

Önerilen:

**NestJS \+ TypeScript**

Alternatif:

**FastAPI / Python**

Ancak ana uygulama TypeScript, AI worker Python şeklinde ayrılabilir.

---

## **Database**

**PostgreSQL**

zorunlu ana database olacaktır.

---

## **Cache / Queue**

**Redis**

kullanılacaktır.

---

## **Git Engine**

Git altyapısını sıfırdan yazmak yerine:

**Forgejo**

kullanılması önerilir.

Project Hub kullanıcıya kendi arayüzünü gösterecek ancak repository işlemleri Forgejo üzerinden yürüyebilecektir.

---

# **7\. PROJECT MANIFEST STANDARDI**

Her proje için Project Hub'ın anlayacağı standart proje tanımı oluşturulacaktır.

Dosya:

projecthub.yml

Örnek:

project:  
  name: ecommerce  
  slug: ecommerce  
  version: 2.4.1

runtime:  
  type: node  
  version: 22

install:  
  command: npm ci

build:  
  command: npm run build

start:  
  command: npm run start  
  port: 3000

health:  
  path: /api/health

database:  
  type: postgresql

preview:  
  enabled: true  
  ttl: 24h

security:  
  dependencyScan: true  
  secretScan: true

ai:  
  indexing: true  
  codeReview: true

Ama kullanıcı bunu baştan yazmak zorunda olmayacaktır.

AI / Project Scanner proje dosyalarını analiz ederek ilk manifest'i otomatik oluşturacaktır.

---

# **8\. SMART PROJECT IMPORT**

Yeni proje eklenirken kullanıcıya iki ana seçenek gösterilir.

### **Create New Project**

Sıfırdan proje oluşturur.

### **Import Existing Project**

Mevcut projeyi sisteme aktarır.

Import kaynakları:

* Git URL  
* GitHub  
* GitLab  
* Forgejo  
* ZIP  
* Local Agent  
* SFTP  
* Server directory

---

# **9\. OTOMATİK PROJE TANIMA**

Repository geldikten sonra sistem analiz başlatır.

Örneğin:

Analyzing project...

✓ package.json found  
✓ Next.js detected  
✓ TypeScript detected  
✓ PostgreSQL detected  
✓ Prisma detected  
✓ Dockerfile detected  
✓ .env.example detected  
✓ 14 environment variables detected  
✓ npm run build verified

Sonuç:

Project Type  
Next.js Web Application

Runtime  
Node.js 22

Database  
PostgreSQL

ORM  
Prisma

Build Command  
npm run build

Application Port  
3000

Kullanıcı:

**Apply Configuration**

diyebilir.

---

# **10\. ANA TASARIM DİLİ**

Project Hub developer-oriented profesyonel bir ürün olacaktır.

Tasarım yaklaşımı:

* Yoğun ancak düzenli bilgi mimarisi  
* Desktop-first  
* Responsive  
* Dark mode  
* Light mode  
* Keyboard shortcuts  
* Command palette  
* Reusable status badge sistemi  
* Drawer tabanlı hızlı işlemler  
* Detail page \+ contextual sidebar  
* Minimum gereksiz modal  
* Kritik işlemlerde confirmation  
* AI'ın ayrı ancak her yerde ulaşılabilir olması

---

# **11\. GLOBAL APP SHELL**

Ana uygulama üç alana ayrılır.

┌──────────────────────────────────────────────────────────┐  
│ Top Navigation                                           │  
├────────────┬─────────────────────────────────┬───────────┤  
│            │                                 │           │  
│ Sidebar    │ Main Content                    │ Context   │  
│            │                                 │ Panel     │  
│            │                                 │           │  
└────────────┴─────────────────────────────────┴───────────┘  
---

# **12\. GLOBAL TOP BAR**

Topbar:

\[Logo\] \[Organization ▼\] \[Global Search\] \[⌘K\]

                           \[Tasks\]  
                           \[Notifications\]  
                           \[AI\]  
                           \[User\]

Global Search ile:

* Project  
* Commit  
* File  
* User  
* Deployment  
* Feedback  
* Build  
* Security issue  
* Documentation

aranabilir.

---

# **13\. GLOBAL COMMAND PALETTE**

Kısayol:

**CTRL/CMD \+ K**

Komut örnekleri:

\> Open ecommerce  
\> Deploy CRM staging  
\> Create preview  
\> Scan API project  
\> Ask AI  
\> Invite user  
\> Find commit  
---

# **14\. ADMINISTRATION CONTROL CENTER**

Admin panel ana navigasyonu:

Overview

Projects  
Users  
Teams  
Roles & Permissions

Infrastructure  
 ├─ Servers  
 ├─ Runners  
 ├─ Agents  
 ├─ Storage  
 └─ Domains

Deployments  
Security Center  
AI Control Center  
Backups  
Integrations  
Audit Logs  
Notifications  
System Health  
Settings  
---

# **15\. ADMIN — OVERVIEW**

URL:

/admin

Amaç:

Sistemin genel durumunu tek ekranda göstermek.

### **Üst KPI Kartları**

42 Projects  
18 Active

6 Running Previews

2 Failed Builds

3 Security Alerts

5 Pending Reviews  
---

## **Project Health Bölümü**

Örneğin:

| Project | Health | Build | Security | Production |
| ----- | ----- | ----- | ----- | ----- |
| CRM | 92 | Passing | Safe | Healthy |
| Shop | 81 | Passing | Warning | Healthy |
| API | 64 | Failed | Critical | Degraded |

---

## **Recent Deployments**

Son deploymentlar gösterilir.

Alanlar:

* Project  
* Version  
* Environment  
* User  
* Time  
* Status  
* Duration

---

## **Infrastructure**

Grafikler:

* CPU  
* RAM  
* Disk  
* Network  
* Active containers  
* Build queue

---

## **AI Insights**

Örneğin:

> 3 proje eski dependency kullanıyor.

> Ecommerce projesinde son 7 günde error rate %31 arttı.

> CRM projesinin test coverage oranı düşüyor.

Buton:

**View AI Report**

---

# **16\. ADMIN — PROJECTS**

URL:

/admin/projects

Tablo:

| Project | Type | Owner | Version | Status | Health | Last Deploy |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

Filtreler:

* Active  
* Archived  
* Technology  
* Team  
* Environment  
* Health  
* Security

Top action:

**\+ New Project**

---

# **17\. ADMIN — USERS**

URL:

/admin/users

Tablo:

* Avatar  
* Name  
* Email  
* Role  
* Teams  
* Project count  
* Last activity  
* MFA  
* Status

Actions:

* Invite  
* Suspend  
* Change role  
* Reset sessions  
* Project access  
* Audit activity

---

# **18\. ADMIN — USER DETAIL**

Header:

Ahmet Yılmaz  
Developer  
Active

Tabs:

Overview  
Projects  
Permissions  
Sessions  
Activity  
API Tokens  
Security  
---

# **19\. ADMIN — ROLE & PERMISSION**

Hazır roller:

* Super Admin  
* Organization Admin  
* Project Manager  
* Lead Developer  
* Developer  
* QA  
* Designer  
* Viewer  
* Customer

Permission sistemi yalnızca rol bazlı olmayacaktır.

Örnek permission:

project.read  
project.write

repository.read  
repository.push

preview.create  
preview.delete

deployment.staging  
deployment.production

secret.read  
secret.write

security.manage

ai.execute  
ai.approve

review.create

admin.users.manage  
---

# **20\. ADMIN — INFRASTRUCTURE**

URL:

/admin/infrastructure

Kartlar:

Main Server  
8 GB RAM  
200 GB Disk  
Online

Build Runner  
Online

Preview Runner  
Online  
---

# **21\. SERVER DETAIL**

Gösterilecek bilgiler:

* Hostname  
* IP  
* OS  
* CPU  
* RAM  
* Disk  
* Docker  
* Running services  
* Active builds  
* Active previews  
* Network  
* Last heartbeat

Actions:

Drain Server  
Restart Worker  
View Logs  
Maintenance Mode  
---

# **22\. STORAGE MANAGEMENT**

Admin görebilmeli:

Repositories       34 GB  
Artifacts          42 GB  
Docker Images      51 GB  
Previews           18 GB  
Backups            39 GB  
Logs                8 GB  
AI Index             4 GB

Storage policy uygulanacaktır.

Örneğin:

Temporary build     3 days  
Preview             7 days  
Raw logs           14 days  
Screenshots        30 days  
Release artifact    Keep  
Source repository   Keep  
---

# **23\. ADMIN — DEPLOYMENT CENTER**

Tüm şirket deploymentları tek yerde görülebilir.

Filtreler:

* Project  
* User  
* Date  
* Environment  
* Status  
* Version

Status:

Queued  
Building  
Testing  
Scanning  
Deploying  
Verifying  
Completed  
Failed  
Rolled Back  
---

# **24\. ADMIN — SECURITY CENTER**

Dashboard:

Security Score: 86/100

Kartlar:

Critical       2  
High           7  
Medium        18  
Low           42

Sekmeler:

Vulnerabilities  
Secrets  
Dependencies  
Containers  
Code  
Policies  
Incidents  
---

# **25\. ADMIN — AI CONTROL CENTER**

Bu ekran kritik olacaktır.

Admin burada AI davranışını belirler.

### **AI Autonomy Level**

L0 Off

L1 Read & Explain

L2 Suggest Changes

L3 Prepare Changes

L4 Execute Safe Operations

L5 Autonomous Policy-Based Operations

Başlangıç önerisi:

**L2**

AI kod önerir ancak kullanıcı onayı olmadan kod değiştirmez.

İlerleyen faz:

L3/L4.

---

# **26\. AI BUDGET MANAGEMENT**

Admin belirleyebilir:

Monthly AI Budget

Per Project Limit

Daily Agent Limit

Allowed Models

Maximum Task Duration  
---

# **27\. AI ACTION POLICIES**

Örneğin:

AI may read source       YES

AI may create branch     YES

AI may commit            YES

AI may merge             APPROVAL

AI may deploy staging    APPROVAL

AI may deploy production NEVER

AI may access secrets    NEVER

AI may query prod DB     READ-ONLY / POLICY  
---

# **28\. ADMIN — AUDIT LOG**

Her önemli işlem immutable mantıkla kaydedilir.

Örnek:

10:21 Ezgi  
created customer review link

10:24 System  
preview container started

10:30 Customer  
created feedback FB-142

10:41 AI Agent  
prepared fix PH-882

11:03 Ezgi  
approved merge

11:08 System  
deployed v2.8.3

Filtre:

* User  
* AI  
* System  
* Project  
* Action  
* IP  
* Date

---

# **29\. PROJECT WORKSPACE**

Kullanıcı bir projeye girdiğinde:

E-Commerce Platform  
Production Healthy  
v2.8.4

Sol menü:

Overview

Code  
 ├─ Files  
 ├─ Branches  
 ├─ Commits  
 ├─ Pull Requests  
 └─ Releases

Builds

Preview  
Simulator

Environments  
Deployments  
Versions

Database  
Secrets

Feedback  
Reviews

AI Assistant

Security

Observability  
 ├─ Logs  
 ├─ Metrics  
 ├─ Traces  
 └─ Incidents

Documentation  
Activity

Settings  
---

# **30\. PROJECT OVERVIEW PAGE**

URL:

/projects/ecommerce

Header:

E-Commerce  
Production  
v2.8.4  
main

Quick actions:

Open Preview

Create Review

Deploy

Ask AI

Open Workspace  
---

## **Overview Cards**

Latest Build  
Passing

Production  
Healthy

Security  
88/100

Open Feedback  
7

AI Issues  
3  
---

## **Environment Summary**

Development    Healthy  
Staging        Healthy  
Production     Healthy  
---

## **Latest Activity**

Timeline format.

---

## **AI Project Summary**

Örnek:

> Son deployment başarılı.

> Son 24 saatte 3 yeni feedback geldi.

> 2 dependency güvenlik güncellemesi mevcut.

> Production error rate normal seviyede.

---

# **31\. CODE — FILE EXPLORER**

Arayüz:

FILE TREE             CODE VIEW              AI CONTEXT  
src/  
 ├ components/  
 ├ pages/  
 ├ services/  
 └ utils/

Kod editörü:

* Syntax highlight  
* Diff  
* Blame  
* History  
* Search  
* Copy path

Actions:

Ask AI

Explain

Find References

Security Scan

View History  
---

# **32\. FILE AI CONTEXT**

Bir dosyada:

**Ask AI**

tıklanırsa AI yalnızca dosyayı değil ilgili bağımlılıkları da inceleyebilir.

Örnek:

> Bu servis ne yapıyor?

> Bu kod nerede kullanılıyor?

> Bunu değiştirirsek ne etkilenir?

> Güvenlik sorunu var mı?

---

# **33\. BRANCHES PAGE**

Tablo:

* Branch  
* Author  
* Last Commit  
* Status  
* Ahead  
* Behind  
* Preview  
* Updated

Her branch için:

Open Preview  
Compare  
Create PR  
AI Review  
Delete  
---

# **34\. COMMITS PAGE**

Her commit:

3fa82a  
Fix checkout validation

Ezgi  
12 minutes ago

4 files changed  
\+82 \-19

Actions:

View Diff  
AI Explain  
Create Preview  
Rollback  
---

# **35\. BUILD PAGE**

Her build için pipeline görünümü:

Checkout  
   ↓  
Install  
   ↓  
Security Scan  
   ↓  
Build  
   ↓  
Unit Tests  
   ↓  
Artifact  
   ↓  
Preview

Her adım ayrı status gösterir.

---

# **36\. BUILD FAILURE EXPERIENCE**

Sistem yalnızca:

**Build Failed**

dememelidir.

Örnek:

Build \#184 failed.

Step:  
TypeScript Compile

File:  
src/services/UserService.ts

Error:  
Property "phone" does not exist on UserDTO.

AI Analysis:

> UserDTO son committe değişmiş ancak UserService güncellenmemiş olabilir.

Actions:

View Logs

Ask AI

Prepare Fix

Retry Build  
---

# **37\. PREVIEW PAGE**

URL:

/projects/ecommerce/preview

Preview listesi:

| Preview | Source | Status | Created | Expires |
| :---: | :---: | :---: | :---: | :---: |

Preview URL örneği:

feature-checkout-a81.preview.company.com  
---

# **38\. PREVIEW DETAIL**

Topbar:

Preview \#184

Branch feature/checkout

\[Desktop ▼\]

Refresh  
Share  
Open New Window  
Stop

Alt bölüm:

Canlı uygulama.

Sağ drawer:

Build  
Console  
Network  
Errors  
Feedback  
---

# **39\. SIMULATOR PAGE**

Simulator ekranı ürünün önemli parçalarından olacaktır.

┌─────────────────────────────────────────┐  
│ Project  Device        Rotate  Zoom     │  
├─────────────────────────────────────────┤  
│                                         │  
│             DEVICE FRAME                │  
│                                         │  
├─────────────────────────────────────────┤  
│ Console Network Screenshot Accessibility│  
└─────────────────────────────────────────┘  
---

# **40\. DEVICE PROFILES**

İlk sürümde yaklaşık 15–20 profil.

Gruplar:

### **Mobile**

* Small Phone  
* Standard Phone  
* Large Phone  
* iPhone size classes  
* Android size classes

### **Tablet**

* Small tablet  
* Standard tablet  
* Large tablet

### **Desktop**

* 1280  
* 1366  
* 1440  
* 1920  
* 2560

Bu aşamada gerçek cihaz emülasyonu değil, web viewport/browser emülasyonu yapılır.

---

# **41\. RESPONSIVE AUTO TEST**

Buton:

**Test All Devices**

Sistem örneğin 20 viewport üzerinde test gerçekleştirir.

Sonuç:

18 Passed  
2 Warning

Issues:

Small Phone  
Horizontal overflow detected.

Tablet Portrait  
CTA partially outside viewport.  
---

# **42\. VISUAL REGRESSION**

Yeni versiyon eski versiyon ile görsel olarak karşılaştırılabilir.

Ekran:

Previous                   Current  
v2.8.3                     v2.8.4

Slider ile fark gösterilebilir.

AI:

> Checkout CTA konumu 18 px değişmiş.

---

# **43\. ENVIRONMENTS PAGE**

Standart ortamlar:

Development  
Staging  
Production

Her environment:

* URL  
* Version  
* Commit  
* Health  
* Deployment time  
* Database  
* Variables  
* Server

---

# **44\. DEPLOYMENT PAGE**

Kullanıcı:

**Deploy**

butonuna basar.

Drawer:

Deploy E-Commerce

Environment:  
\[Staging ▼\]

Source:  
main

Version:  
v2.8.4

Run tests:  
✓

Security scan:  
✓

Backup:  
✓

Database migrations:  
2 detected

\[Cancel\] \[Start Deployment\]  
---

# **45\. DEPLOYMENT WORKFLOW**

Deployment:

Permission Check

↓  
Source Validation

↓  
Dependency Check

↓  
Tests

↓  
Security Scan

↓  
Build

↓  
Artifact Creation

↓  
Backup

↓  
Migration Validation

↓  
Deploy

↓  
Health Check

↓  
Smoke Test

↓  
Release Finalization  
---

# **46\. DEPLOYMENT ADAPTERS**

Sistem tek deployment yöntemine bağlı olmayacaktır.

Adapter yapısı:

SFTP  
SSH  
Rsync  
Docker  
Docker Compose  
Static Upload  
API Deployment  
Kubernetes  
Custom Plugin

Manager'ın istediği FTP motoru desteklenecektir.

Ancak güvenlik açısından varsayılan yöntem:

**SFTP/SSH**

olmalıdır.

Plain FTP yalnızca legacy adapter olarak açılmalıdır.

---

# **47\. CONNECTION PROFILE**

Deployment bağlantı bilgileri proje içerisinde profile dönüştürülür.

Örneğin:

Production Server

Protocol  
SFTP

Host  
server.company.com

Port  
22

Username  
deploy

Credential  
production-sftp-secret

Remote Path  
/var/www/project

Şifre UI'da tekrar gösterilmez.

Database'e düz metin password kaydedilmez.

---

# **48\. VERSION MANAGEMENT**

Her release:

v2.8.4

bilgisine sahip olacaktır.

Detay:

* Commit  
* Build  
* Release notes  
* Deployment  
* Migration  
* Artifact  
* Created by  
* Date

---

# **49\. UPDATE MODULE**

Project Hub'ın kendisinin ve yönetilen projelerin update süreçleri ayrı ele alınacaktır.

Bir update:

Current  
v2.8.4

Target  
v2.9.0

Sistem update öncesi analiz yapar.

✓ Backup available  
✓ Source compatible  
✓ Database connection available

2 migrations detected  
1 configuration change detected  
---

# **50\. DATABASE DATA PROTECTION**

Manager'ın özellikle belirttiği veri koruma gereksinimi kritik kabul edilecektir.

Update sırasında:

Backup  
↓  
Migration validation  
↓  
Migration execution  
↓  
Application deployment  
↓  
Health validation

Migration başarısız olursa deployment tamamlanmış sayılmaz.

---

# **51\. DATABASE PAGE**

Burada direkt production database management tool yapılmayacaktır.

Project Hub güvenli meta yönetimi sağlar.

Gösterilenler:

PostgreSQL  
Healthy

Schema Version  
128

Pending Migrations  
2

Last Backup  
12 min ago

Tabs:

Overview  
Migrations  
Backups  
Connections  
Performance  
---

# **52\. MIGRATION PAGE**

Migration örneği:

20261007\_add\_customer\_status

Status  
Pending

Operations

ADD COLUMN  
customers.status

CREATE INDEX  
customers\_status\_idx

AI Risk:

Risk  
LOW  
---

# **53\. BACKUP PAGE**

Backup kayıtları:

BKP-8841

Environment  
Production

Version  
2.8.4

Database  
PostgreSQL

Size  
2.8 GB

Created  
Before Deployment \#882

Actions:

Verify

Restore to Test

Download if authorized

Delete if policy permits

Production restore ayrıca approval gerektirir.

---

# **54\. SECRETS PAGE**

Secret türleri:

Database Credentials  
API Keys  
Deployment Credentials  
Signing Keys  
External Services

Liste:

STRIPE\_SECRET  
••••••••••  
Updated 12 days ago

Default olarak secret değeri görüntülenmez.

---

# **55\. CUSTOMER REVIEWS PAGE**

Project içerisindeki müşteri review session'ları burada görünür.

| Review | Version | Customer | Feedback | Expires | Status |
| :---: | :---: | :---: | :---: | :---: | :---: |

Action:

**Create Review**

---

# **56\. CREATE CUSTOMER REVIEW FLOW**

Step 1:

### **Source**

Version  
v2.8.4

Environment  
Preview

Step 2:

### **Access**

Expires  
24 hours

Password  
Optional

Single IP  
Optional

Step 3:

### **Capabilities**

✓ Feedback

✓ Screenshots

✓ Device switch

✓ Chat

□ Download

□ Developer console

Step 4:

**Create Review Link**

---

# **57\. REVIEW LINK SECURITY**

Review link örneği:

review.company.com/r/8Fa2nM4k

Token:

* Uzun  
* Random  
* Tahmin edilemez  
* Database'te mümkünse hash olarak saklanır

Session:

created\_at  
expires\_at  
revoked\_at  
last\_access\_at  
access\_count

Admin istediği an:

**Revoke**

yapabilir.

---

# **58\. CUSTOMER REVIEW PORTAL**

Müşterinin gördüğü ekran Project Hub'ın admin arayüzüne benzemez.

Çok sade olacaktır.

┌──────────────────────────────────────────────┐  
│ Company Logo   Project Name      18h left   │  
├──────────────────────────────────────────────┤  
│                                              │  
│               LIVE PROJECT                   │  
│                                              │  
│                                              │  
├───────────────────────────────┬──────────────┤  
│ Device   Feedback Mode        │ Feedback (4) │  
└───────────────────────────────┴──────────────┘  
---

# **59\. CUSTOMER TOP BAR**

İçerik:

Company Logo

E-Commerce Redesign

v2.8 Preview

Desktop ▼

Feedback Mode

4 Comments

Expires in 18h  
---

# **60\. CUSTOMER FEEDBACK MODE**

Müşteri:

**Add Feedback**

der.

Sayfa üzerinde istediği yere tıklar.

Pin oluşur:

①

Sağ drawer açılır.

New Feedback

Page  
/products/14

Device  
Mobile

Write your feedback...

\[Attach Screenshot\]

\[Send\]  
---

# **61\. OTOMATİK FEEDBACK CONTEXT**

Feedback oluşturulduğunda sistem mümkün olduğu kadar otomatik context toplar.

Page URL

Route

Viewport

Browser

Operating System

Version

Build

Screenshot

Click coordinates

DOM selector

Timestamp

Bu bilgiler müşteriden istenmez.

---

# **62\. FEEDBACK MODEL**

Her feedback:

FB-184

Title  
Checkout button too small

Status  
Open

Priority  
Medium

Reporter  
Customer

Version  
v2.8.4

Assigned  
Ezgi

Status:

Open  
Triaged  
Planned  
In Progress  
Ready for Review  
Resolved  
Rejected  
---

# **63\. AI FEEDBACK ANALYSIS**

AI yeni feedback geldiğinde otomatik özetleyebilir.

Örnek:

> Müşteri mobil checkout butonunun küçük olduğunu belirtiyor.

AI otomatik:

Category  
UI

Severity  
Low

Affected  
Mobile Checkout

Likely File  
components/CheckoutButton.tsx

önerir.

---

# **64\. FEEDBACK → TASK**

Buton:

**Convert to Task**

Task:

PH-812

Increase checkout CTA size on small mobile screens.

AI:

Possible files:  
CheckoutButton.tsx  
checkout.css  
---

# **65\. FEEDBACK → AI FIX**

Yetki varsa:

**Prepare Fix with AI**

AI ayrı workspace oluşturur.

Task  
PH-812

Branch  
ai/ph-812-checkout-button

AI ana branch'i doğrudan değiştirmez.

---

# **66\. AI DEVELOPMENT WORKFLOW**

Feedback  
↓  
AI Analysis  
↓  
Task  
↓  
AI Workspace  
↓  
Code Change  
↓  
Unit Test  
↓  
Build  
↓  
Security Scan  
↓  
Preview  
↓  
Visual Test  
↓  
Human Approval  
↓  
Merge  
---

# **67\. CUSTOMER RE-REVIEW**

Fix hazır olduğunda müşteriye aynı review session üzerinden:

New version available  
v2.8.5

gösterilebilir.

Customer:

**Compare**

diyebilir.

Feedback:

Ready for Review

durumuna geçer.

Customer:

✓ Approved

Still needs work

seçebilir.

---

# **68\. REVIEW EXPIRATION**

Süre dolduğunda:

Preview gerekiyorsa durdurulur.

Müşteri:

This review link has expired.

Please contact the project team for a new review link.

ekranını görür.

Backend kaydı silinmez.

Session:

**Expired**

durumuna geçer.

---

# **69\. CUSTOMER LIVE SUPPORT**

Review panelinde Chat sekmesi bulunabilir.

Customer:

> Mobil menüde farklı bir şey fark ettim.

yazar.

Mesaj proje review session'ına bağlanır.

Developer Project Hub üzerinden cevaplayabilir.

---

# **70\. AI PROJECT ASSISTANT**

Her projede sağ üstte:

**Ask Project AI**

butonu bulunur.

AI proje context'ine sahip olur.

Sorular:

> Bu proje nasıl çalışıyor?

> Login nerede?

> Payment akışı nasıl?

> Son deployment neden başarısız oldu?

> Son müşterinin feedbacklerini özetle.

> Güvenlik sorunlarını göster.

> Bu fonksiyonu değiştirirsek ne etkilenir?

---

# **71\. PROJECT BRAIN**

AI'ın bildiği veri kaynakları:

Source Code

Git History

Project Manifest

Documentation

Database Schema

Build History

Deployments

Security Results

Logs

Incidents

Customer Feedback

Tasks

Architecture Decisions  
---

# **72\. AI KNOWLEDGE INDEX**

Her repository update edildiğinde tüm proje baştan indekslenmemelidir.

Incremental indexing yapılacaktır.

Değişen dosyalar yeniden işlenir.

Metadata:

file  
symbol  
function  
class  
dependency  
commit  
module  
route  
database table  
API endpoint  
---

# **73\. CODE RELATIONSHIP GRAPH**

İleri faz:

CheckoutController  
        ↓  
CheckoutService  
        ↓  
PaymentService  
        ↓  
StripeAdapter

AI:

> PaymentService değişirse neresi etkilenir?

sorusuna dependency graph üzerinden cevap verir.

---

# **74\. AI AGENT MİMARİSİ**

Tek AI her işi yapmayacaktır.

### **Project Manager Agent**

Ana orchestrator.

Alt ajanlar:

Architect Agent

Code Agent

QA Agent

Security Agent

Database Agent

DevOps Agent

Frontend Agent

Performance Agent

Documentation Agent

Project Manager Agent görevi doğru uzman ajanlara dağıtır.

---

# **75\. AI TASK SCREEN**

Project AI Center:

AI Tasks

Örnek:

AI-284

Fix checkout mobile spacing

Status  
Awaiting Approval

Files Changed  
4

Tests  
32 Passed

Security  
Passed

Preview  
Available

Actions:

Review Changes

Open Preview

Approve

Reject  
---

# **76\. AI CHANGE REVIEW**

Ekran üç kolon olabilir.

Files            Diff                   AI Explanation

AI açıklama:

> Checkout CTA minimum height 44px olarak değiştirildi.

> Sadece viewport \<480px etkileniyor.

> Desktop stil değiştirilmedi.

---

# **77\. AI'NIN KIRMIZI ÇİZGİLERİ**

AI başlangıçta:

* Production'a doğrudan deploy yapamaz.  
* Production database silemez.  
* Secret okuyamaz.  
* Kullanıcı yetkisi değiştiremez.  
* Audit kayıtlarını silemez.  
* Ana branch'e direkt push yapamaz.  
* Güvenlik policy'sini devre dışı bırakamaz.

Bu sınırlar yalnız prompt ile değil backend policy ile korunur.

---

# **78\. SECURITY ENGINE**

Her proje için otomatik security pipeline çalışabilir.

Source Scan

Dependency Scan

Secret Scan

Container Scan

Configuration Scan  
---

# **79\. SECURITY ISSUE PAGE**

Issue:

SEC-184

Severity  
Critical

Type  
Secret Exposure

File  
config/payment.ts

Detected  
AWS Credential Pattern

Actions:

Assign

Suppress

Mark False Positive

Ask AI

Prepare Fix  
---

# **80\. PROJECT SECURITY SCORE**

Örnek:

Security Score  
87 / 100

Breakdown:

Source          92  
Dependencies    81  
Secrets        100  
Container       84  
Configuration   78  
---

# **81\. DEPENDENCY CENTER**

Liste:

Package  
Current  
Latest  
Security  
Risk

AI:

> package X güncellenebilir.

> 2 breaking change mevcut.

> 4 dosyanın etkilenmesi bekleniyor.

Action:

**Prepare Upgrade**

---

# **82\. OBSERVABILITY**

Project Hub dört tür operasyon bilgisi gösterecektir.

Logs

Metrics

Traces

Incidents  
---

# **83\. LOGS PAGE**

Search:

Search logs...

Filtre:

* Environment  
* Service  
* Level  
* Date  
* Trace ID

AI action:

**Summarize Logs**

Örnek:

> Son bir saatte 84 hata oluştu.

> %78 Payment API timeout kaynaklı.

---

# **84\. METRICS PAGE**

İlk önemli metricler:

Request rate

Error rate

Latency

CPU

Memory

Database connections

Queue length

Container restarts  
---

# **85\. TRACE VIEW**

Bir request'in akışı:

Frontend       82 ms  
API           123 ms  
OrderService   44 ms  
Payment       188 ms  
Database       12 ms

AI:

> Gecikmenin çoğu Payment provider'dan geliyor.

---

# **86\. INCIDENT MANAGEMENT**

Bir production problemi:

INC-184

Checkout API error spike

Started  
14:31

Severity  
High

Affected  
Production

Timeline:

14:31 Alert  
14:33 AI Analysis  
14:35 Engineer Assigned  
14:44 Hotfix Build  
14:50 Staging Test  
15:02 Production Deploy  
15:05 Recovered  
---

# **87\. AUTOMATIC POSTMORTEM**

Incident kapatılınca AI taslak hazırlar.

What happened?

Impact

Root cause

Resolution

Prevention

Follow-up tasks  
---

# **88\. PROJECT HEALTH SCORE**

Her proje tek skorla özetlenebilir.

Project Health  
84/100

Bileşenler:

Build  
Security  
Tests  
Performance  
Dependencies  
Documentation  
Deployment  
Incidents

Bu skor kesin bilimsel ölçüm gibi sunulmamalıdır.

Bir yönetim sinyalidir.

---

# **89\. TECHNICAL DEBT**

AI proje içerisindeki teknik borcu takip eder.

Örnek:

Technical Debt  
Medium

Detay:

Deprecated packages      4

TODO/FIXME              18

Large functions         12

Duplicate code           7

Missing tests           14  
---

# **90\. DOCUMENTATION CENTER**

Her proje:

README

Architecture

Setup

API

Database

Deployment

Runbooks

Decisions

bölümlerine sahip olabilir.

AI değişiklik sonrası:

**Documentation may be outdated**

uyarısı verebilir.

---

# **91\. ARCHITECTURE DECISION RECORDS**

Önemli teknik kararlar kaydedilir.

Örnek:

ADR-012

Use PostgreSQL for primary database.

Status  
Accepted

Date  
2026-10-07

Böylece ileride AI:

> Neden MongoDB yerine PostgreSQL kullanılmış?

sorusunu cevaplayabilir.

---

# **92\. PROJECT ARCHIVE**

Manager'ın istediği merkezi proje arşivi ayrı bir özellik olacaktır.

Project status:

Active

Maintenance

Paused

Archived

Archived proje silinmez.

Repository, release, documentation, audit ve gerekli artifactlar korunur.

---

# **93\. PROJECT ARCHIVE PAGE**

Filtre:

Year  
Technology  
Customer  
Owner  
Status

AI search:

> 2024'te yaptığımız Laravel ödeme projesini bul.

---

# **94\. REMOTE DEVELOPMENT**

İleri fazda kullanıcı projeyi bilgisayarına indirmeden geliştirebilir.

Button:

**Open Workspace**

Workspace:

Starting...

Repository mounted

Dependencies ready

Environment loaded

Kullanıcı:

Open VS Code

Open Web IDE

Open Terminal

seçebilir.

---

# **95\. WORKSPACE LIFECYCLE**

Status:

Stopped

Starting

Running

Idle

Stopping

Failed

Idle workspace otomatik kapatılabilir.

Bu sunucu kaynaklarını korur.

---

# **96\. LOCAL AGENT**

Windows/macOS uygulaması.

Agent ekranı:

Project Hub Agent

Connected

Device  
Ezgi-MacBook

Allowed Folders  
/Projects

Capabilities

✓ File Transfer

✓ Local Preview

✓ Browser Testing

□ Terminal Command

□ Full Disk Access

Yetkiler granular olacaktır.

---

# **97\. AGENT CONNECTION SECURITY**

Agent:

* Device identity  
* Pairing token  
* TLS connection  
* Permission scope  
* Session expiry  
* Audit log

ile korunur.

Project Hub local makine üzerinde keyfi işlem yapamaz.

---

# **98\. EVENT ARCHITECTURE**

Önemli olaylar event oluşturacaktır.

ProjectCreated

ProjectImported

CommitPushed

BuildStarted

BuildFailed

BuildCompleted

PreviewCreated

FeedbackCreated

AIFixPrepared

DeploymentStarted

DeploymentCompleted

DeploymentFailed

SecurityIssueFound

IncidentCreated  
---

# **99\. EVENT'İN FAYDASI**

Örneğin:

FeedbackCreated

event'i oluşur.

Ardından:

Notification Service  
        ↓  
AI Triage  
        ↓  
Project Timeline  
        ↓  
Webhook

aynı event'i tüketebilir.

Bu sayede modüller birbirine sıkı bağımlı olmaz.

---

# **100\. WORKFLOW ENGINE**

Uzun işlemler normal HTTP request içinde yapılmaz.

Örneğin deployment:

HTTP Request  
↓  
Workflow Created  
↓  
202 Accepted

Sonra kullanıcı UI'dan canlı status takip eder.

İleri fazda durable workflow engine kullanılabilir.

---

# **101\. NOTIFICATION CENTER**

Bildirim kategorileri:

Build

Deployment

Security

Feedback

AI

System

User

Notification preferences:

In-app

Email

Webhook

Slack/Teams later  
---

# **102\. GLOBAL TASK CENTER**

Kullanıcıya sadece notification değil aksiyon listesi gösterilmelidir.

Örnek:

Needs Your Attention

3 Customer Feedback

1 Failed Deployment

2 AI Changes Awaiting Approval

1 Critical Security Issue  
---

# **103\. HOTFIX FLOW**

Manager'ın özellikle istediği hızlı düzeltme süreci:

Customer Feedback

↓  
Triage

↓  
Hotfix Task

↓  
Hotfix Branch

↓  
Code / AI Fix

↓  
Tests

↓  
Preview

↓  
Review

↓  
Production Deploy

↓  
Feedback Resolved  
---

# **104\. RELEASE FLOW**

Normal release:

Feature Branch

↓  
Pull Request

↓  
Review

↓  
Merge

↓  
Build

↓  
QA

↓  
Version

↓  
Staging

↓  
Approval

↓  
Production  
---

# **105\. ROLLBACK FLOW**

Production sorununda:

Deployment Failed  
↓  
Health Check Failed  
↓  
Rollback Policy

Sistem önce:

Current  
v2.9.0

Previous Stable  
v2.8.4

gösterir.

Rollback action:

Application rollback

Configuration rollback

Migration strategy

Database rollback otomatik varsayılmamalıdır.

Migration tipine göre risk analizi yapılmalıdır.

---

# **106\. POLICY ENGINE**

Kritik işlemler policy ile korunur.

Örnek:

IF environment \= production

AND security.critical \> 0

THEN deployment \= DENY

Başka örnek:

IF actor \= AI

AND environment \= production

THEN require human approval  
---

# **107\. MULTI-APPROVAL**

İleri faz:

Bazı production projelerde iki kişi onayı gerekebilir.

Production deployment

Required approvals  
2

Örneğin:

Developer \+ Manager.

---

# **108\. SYSTEM HEALTH**

Admin ekranı:

Project Hub API       Healthy

PostgreSQL            Healthy

Redis                 Healthy

Git                   Healthy

Build Worker          Healthy

Preview Worker        Healthy

Storage               72%

AI Provider           Healthy  
---

# **109\. 8 GB RAM / 200 GB DİSK STRATEJİSİ**

İlk sunucuda aynı anda her şeyi sınırsız çalıştırmak mümkün olmayacaktır.

Bu nedenle Resource Scheduler gereklidir.

Örneğin:

Max concurrent builds  
1

Max concurrent preview builds  
2

Max AI indexing jobs  
1

Maximum preview runtime  
24h  
---

# **110\. PREVIEW RESOURCE CONTROL**

Preview container limitleri:

Örnek başlangıç:

Memory limit  
256–512 MB

CPU limit  
0.5–1 core

TTL  
24 hours

Proje tipine göre değişebilir.

---

# **111\. BUILD QUEUE**

Buildler queue üzerinden yürütülür.

Build \#101 Running

Build \#102 Queued

Build \#103 Queued

Priority:

Hotfix

Production

Staging

Preview

Development  
---

# **112\. STORAGE TEMİZLEME**

Disk %80 olduğunda sistem uyarı verir.

%90'da:

Temporary artifacts temizlenir.

Preview cache temizlenebilir.

Ancak:

* Repository  
* Production backup  
* Release

otomatik silinmez.

---

# **113\. DATABASE ANA ENTITY'LERİ**

Ana PostgreSQL yapısı yaklaşık şu domainleri içerecektir.

### **Identity**

organizations

users

profiles

teams

team\_members

roles

permissions

role\_permissions

user\_project\_permissions

sessions

### **Projects**

projects

project\_members

project\_settings

project\_technologies

project\_manifests

project\_tags

### **Git**

repositories

branches

commits

pull\_requests

releases

Git objelerinin tamamının PostgreSQL'e kopyalanması şart değildir.

Gerekli metadata tutulur.

---

# **114\. BUILD DATA MODEL**

builds

build\_steps

build\_logs

build\_artifacts

build\_test\_results  
---

# **115\. PREVIEW DATA MODEL**

previews

preview\_routes

preview\_devices

preview\_sessions

preview\_screenshots  
---

# **116\. DEPLOYMENT DATA MODEL**

environments

deployment\_targets

deployments

deployment\_steps

deployment\_artifacts

deployment\_approvals

rollbacks  
---

# **117\. VERSION DATA MODEL**

versions

release\_notes

version\_artifacts

version\_migrations  
---

# **118\. DATABASE MANAGEMENT MODEL**

database\_connections

database\_schemas

migrations

migration\_runs

backups

backup\_restores  
---

# **119\. CUSTOMER REVIEW DATA MODEL**

review\_sessions

review\_tokens

review\_visitors

feedback

feedback\_comments

feedback\_attachments

feedback\_context

review\_messages  
---

# **120\. AI DATA MODEL**

ai\_tasks

ai\_runs

ai\_agents

ai\_messages

ai\_actions

ai\_approvals

ai\_code\_changes

ai\_findings

ai\_usage

ai\_context\_index  
---

# **121\. SECURITY DATA MODEL**

security\_scans

security\_findings

dependency\_findings

secret\_findings

security\_exceptions

security\_policies  
---

# **122\. OBSERVABILITY DATA MODEL**

Ham logların tamamı PostgreSQL'e atılmamalıdır.

PostgreSQL'de metadata tutulabilir:

incidents

alerts

health\_checks

monitor\_definitions

Büyük telemetry verisi uygun ayrı storage'a taşınabilir.

---

# **123\. AUDIT MODEL**

audit\_events

Önemli kolonlar:

actor\_type

actor\_id

organization\_id

project\_id

action

resource\_type

resource\_id

metadata

ip

user\_agent

created\_at

Actor type:

USER

AI

SYSTEM

CUSTOMER

AGENT  
---

# **124\. API TASARIMI**

Ana API namespace:

/api/v1

Örnek:

/api/v1/projects

/api/v1/projects/:id

/api/v1/projects/:id/builds

/api/v1/projects/:id/previews

/api/v1/projects/:id/deployments

/api/v1/projects/:id/feedback

/api/v1/projects/:id/security

/api/v1/projects/:id/ai  
---

# **125\. ACTION API'LERİ**

Örneğin:

POST /projects/:id/builds

POST /projects/:id/previews

POST /deployments/:id/approve

POST /deployments/:id/rollback

POST /feedback/:id/ai-fix

POST /ai/tasks/:id/approve  
---

# **126\. ASYNC API DAVRANIŞI**

Uzun süren action:

POST /projects/42/builds

Response:

{  
  "workflowId": "wf\_184",  
  "status": "queued"  
}

Client polling veya websocket/SSE üzerinden ilerlemeyi takip eder.

---

# **127\. REAL-TIME CHANNEL**

Realtime gereken alanlar:

* Build logs  
* Deployment  
* AI execution  
* Customer chat  
* Feedback  
* System status  
* Notifications

SSE veya WebSocket kullanılabilir.

---

# **128\. SECRET ARCHITECTURE**

Secret'ların normal project settings içinde text alanı olarak tutulması yasaktır.

Application yalnız:

secret\_id

referansı kullanmalıdır.

Gelecekte ayrı Vault entegrasyonu yapılabilir.

---

# **129\. PROJECT TYPE TEMPLATES**

Yeni proje oluştururken hazır template olabilir.

Örneğin:

Next.js \+ PostgreSQL

React SPA

Node API

Laravel

Python FastAPI

Static Website

Custom

Template şunları getirir:

* Manifest template  
* Build configuration  
* Security configuration  
* Deployment defaults  
* Preview defaults

---

# **130\. PROJECT CREATION WIZARD**

### **Step 1**

General Information

Project Name

Description

Customer

Team

### **Step 2**

Source

Create Repository

Import Repository

Upload Existing

### **Step 3**

Detection

Project Hub analiz eder.

### **Step 4**

Environment

Development

Staging

Production

### **Step 5**

Database

PostgreSQL connection veya new database.

### **Step 6**

Preview

Enable/Disable.

### **Step 7**

Deployment

Opsiyonel.

### **Step 8**

Review & Create.

---

# **131\. EMPTY STATES**

Her ekran iyi empty state'e sahip olmalıdır.

Örneğin Preview:

No previews yet.

Create a temporary environment to test this project.

\[Create Preview\]

Security:

This project has not been scanned yet.

\[Run First Scan\]  
---

# **132\. LOADING STATES**

Uzun işlemler generic spinner olmamalıdır.

Örneğin:

Preparing source...

Installing dependencies...

Building...

Starting preview...

kullanıcı ne olduğunu anlamalıdır.

---

# **133\. ERROR STATES**

Her hata üç bölümden oluşmalıdır.

What happened

Why it may have happened

What you can do

AI varsa:

**Analyze Error**

butonu gösterilebilir.

---

# **134\. DANGEROUS ACTION DESIGN**

Danger zone:

Delete project

Delete environment

Reset database

Revoke all links

Rotate secrets

Kritik işlemlerde:

* Re-authentication  
* Typed confirmation  
* Audit  
* Permission check

uygulanır.

---

# **135\. GLOBAL ACTIVITY TIMELINE**

Project Timeline bütün modülleri birleştirir.

Örnek:

09:41 Commit pushed

09:42 Build started

09:45 Build passed

09:46 Preview created

10:04 Review shared

10:21 Feedback received

10:34 AI fix prepared

11:02 Merge approved

11:08 Production deployed  
---

# **136\. UNIVERSAL SEARCH**

Search yalnız isim aramayacaktır.

İleri faz doğal dil:

> Stripe ile ilgili geçen ay hangi problemler yaşandı?

> Ahmet'in production'a aldığı son release hangisi?

> Checkout feedbackleri.

> Bu projede JWT nerede oluşturuluyor?

Sonuçlar kategorize edilir.

---

# **137\. HOME DASHBOARD — DEVELOPER**

Developer admin dashboard yerine kişisel home görür.

Good morning

Your Projects

Needs Your Attention

Assigned Feedback

Failed Builds

AI Tasks Awaiting Review

Recent Work  
---

# **138\. HOME DASHBOARD — PROJECT MANAGER**

Project Manager:

Projects At Risk

Customer Reviews

Open Feedback

Upcoming Releases

AI Project Summaries

Deployment History  
---

# **139\. HOME DASHBOARD — SECURITY**

Security rolü:

Critical Issues

New Secrets Detected

Dependency Risk

Unreviewed Exceptions

Security Trend  
---

# **140\. ROLE-BASED UI**

Kullanıcı permission'a sahip değilse yalnız buton disable edilmemelidir.

Gereksiz alanlar çoğu durumda tamamen gizlenir.

Örneğin Customer hiçbir zaman:

Repository  
Secrets  
Deployment  
Admin

görmez.

---

# **141\. CUSTOMER PORTAL BRANDING**

Müşteriye giden portal:

* Company logo  
* Project logo  
* Custom accent  
* Optional customer logo

destekleyebilir.

Project Hub internal branding gösterilmek zorunda değildir.

---

# **142\. ACCESSIBILITY**

UI:

* Keyboard navigation  
* Focus states  
* Screen reader labels  
* Contrast  
* Reduced motion  
* Responsive zoom

desteklemelidir.

Simulator accessibility testi de ileri faza eklenebilir.

---

# **143\. MOBILE ADMIN**

Tam development deneyiminin mobilde verilmesi hedef değildir.

Mobilde:

* Dashboard  
* Notifications  
* Deployment approval  
* Feedback  
* AI summary  
* Incident  
* Review

gibi yönetim işlemleri desteklenebilir.

Kod editörü desktop odaklıdır.

---

# **144\. DARK/LIGHT MODE**

Tema sistem-wide desteklenir.

Tercih:

System

Dark

Light

Project/customer preview içerikleri tema değişikliğinden etkilenmemelidir.

---

# **145\. DESIGN TOKEN SYSTEM**

Frontend'te:

spacing

radius

typography

semantic colors

status colors

elevation

motion

token olarak tanımlanır.

Hard-coded stil kullanımından kaçınılır.

---

# **146\. STATUS STANDARDI**

Sistem genelinde aynı status aynı görünmelidir.

Örnek:

Green  
Healthy / Passed / Completed

Yellow  
Warning / Pending

Red  
Critical / Failed

Blue  
Running / In Progress

Gray  
Stopped / Archived  
---

# **147\. AI UX PRENSİBİ**

AI ayrı “chatbot oyuncağı” olmayacaktır.

AI context'e entegre olur.

Örneğin:

Build ekranında:

**Analyze Failure**

Security ekranında:

**Explain Risk**

Feedback'te:

**Prepare Fix**

Deployment'ta:

**Analyze Risk**

Code'da:

**Explain**

Bu yaklaşım daha pratik olacaktır.

---

# **148\. NATURAL LANGUAGE OPERATIONS**

İleri fazda kullanıcı AI'a:

> CRM'in son stabil sürümünü staging'e al ve 24 saatlik review linki hazırla.

diyebilir.

AI önce plan üretir:

1\. Resolve latest stable version

2\. Run deployment validation

3\. Deploy staging

4\. Run health check

5\. Create customer review

6\. Expire after 24 hours

Sonra:

**Approve Plan**

ister.

---

# **149\. AI SELF-MANAGEMENT**

Nihai sistem doğrudan “AI her şeyi kendi yapsın” mantığıyla başlamayacaktır.

Aşamalı otonomi:

### **Level 1**

AI bilgi verir.

### **Level 2**

AI öneri üretir.

### **Level 3**

AI işlem hazırlar.

### **Level 4**

AI düşük riskli işlemleri gerçekleştirir.

### **Level 5**

AI policy sınırları içerisinde sistem bakımını yürütür.

Bu manager'ın AI'ın sistemi aktif yönetmesi vizyonunu güvenli şekilde gerçekleştirir.

---

# **150\. SELF-HEALING**

İleri faz örneği:

Monitoring:

> API container crashed.

Policy:

restart\_attempts \< 3

ise:

Project Hub container'ı otomatik restart edebilir.

Başarısızsa incident oluşturur.

AI:

root cause analizi yapar.

---

# **151\. AI PROACTIVE MODE**

AI yalnız soru beklememelidir.

Örneğin:

> Son 3 deploymentta build süresi %38 arttı.

> Disk 14 gün içinde dolabilir.

> Projenin kullandığı dependency'de kritik vulnerability bulundu.

> 5 feedback aynı konuyla ilgili.

gibi proaktif insight üretilebilir.

---

# **152\. DAILY PROJECT DIGEST**

İleri faz:

Her proje için daily digest:

Yesterday

4 commits

2 deployments

3 feedback

0 incidents

1 security warning

AI Summary  
---

# **153\. PLUGIN ARCHITECTURE**

Gelecekte:

GitHub

GitLab

Slack

Teams

Jira

Figma

Sentry

Cloudflare

AWS

Azure

Google Cloud

pluginleri eklenebilir.

Core sisteme özel entegrasyon kodu doldurulmamalıdır.

---

# **154\. WEBHOOKS**

Kullanıcı event seçebilir.

Örneğin:

deployment.completed

feedback.created

security.critical\_found

ve webhook URL tanımlayabilir.

---

# **155\. PUBLIC API**

İleri fazda API token ile:

Projects

Builds

Deployments

Versions

Feedback

Reviews

Security

yönetilebilir.

Service account ayrıca desteklenmelidir.

---

# **156\. MULTI-TENANCY HAZIRLIĞI**

İlk kullanım tek şirket olsa bile entity'lerin çoğu:

organization\_id

taşımalıdır.

Böylece ileride Project Hub ticari SaaS ürününe dönüştürülebilir.

---

# **157\. NON-FUNCTIONAL REQUIREMENTS**

## **Security**

Tüm communication HTTPS.

## **Authentication**

Secure session/token.

## **Audit**

Kritik action kayıt altında.

## **Reliability**

Deployment gibi süreçler resume edilebilir.

## **Performance**

Ana panel hızlı açılmalıdır.

## **Scalability**

Build ve preview worker ayrılabilir.

## **Maintainability**

Modüler mimari.

## **Observability**

Project Hub'ın kendisi de izlenebilir olmalıdır.

---

# **158\. PROJECT HUB'IN KENDİSİNİ YÖNETMESİ**

İleri fazda Project Hub kendi source repository'sini de Project Hub projesi olarak yönetebilir.

Yani:

Project Hub  
manages  
Project Hub

Ancak upgrade işlemlerinde özel safe-update mekanizması gerekir.

---

# **159\. PROJECT HUB UPDATE**

Yeni sistem versiyonu:

Current  
2.8.0

Available  
2.9.0

Release note gösterilir.

Pre-flight:

Database backup ✓

Disk capacity ✓

Migration check ✓

Current configuration ✓

Sonra:

**Update**

---

# **160\. SAFE SELF-UPDATE**

Update:

Backup

↓  
Download verified release

↓  
Prepare new container

↓  
Run migrations

↓  
Health check

↓  
Switch traffic

↓  
Keep old release for rollback

Bu sayede sistem güncellenirken kendi verisini korur.

---

# **161\. MVP — FAZ 1**

İlk geliştirilecek gerçek ürün:

### **Core**

* Auth  
* Users  
* Roles  
* Projects  
* PostgreSQL  
* Audit

### **Git**

* Forgejo integration  
* Repository  
* Files  
* Commit/branch metadata

### **Project**

* Overview  
* Project settings  
* Project manifest

### **Server**

* Docker  
* Reverse proxy

---

# **162\. FAZ 2 — BUILD & PREVIEW**

* Worker queue  
* Build engine  
* Build logs  
* Preview  
* Dynamic URL  
* Preview lifecycle  
* Artifact management

Bu aşamadan sonra ürün gerçek anlamda fayda üretmeye başlar.

---

# **163\. FAZ 3 — CUSTOMER REVIEW**

* Temporary URL  
* Expiration  
* Feedback  
* Pin comments  
* Screenshots  
* Feedback task  
* Customer chat

Manager'ın demo/paylaşım ihtiyacı burada tam karşılanır.

---

# **164\. FAZ 4 — SIMULATOR**

* Device profiles  
* Responsive simulator  
* 15–20 ekran  
* Screenshot  
* Automated viewport tests  
* Basic visual regression

---

# **165\. FAZ 5 — DEPLOYMENT**

* SFTP  
* SSH  
* Docker  
* Environment  
* Version  
* Deployment logs  
* Backup  
* Rollback  
* Database migration

---

# **166\. FAZ 6 — AI PROJECT BRAIN**

* Repository indexing  
* Project Q\&A  
* File explain  
* Build analysis  
* Feedback analysis  
* Documentation generation

---

# **167\. FAZ 7 — SECURITY**

* Dependency scanner  
* Secret scanner  
* Container scanner  
* Security score  
* Policy engine

---

# **168\. FAZ 8 — AI ENGINEERING**

* AI workspace  
* Branch creation  
* Code changes  
* Tests  
* Build  
* Preview  
* Approval  
* Merge flow

---

# **169\. FAZ 9 — OBSERVABILITY**

* Logs  
* Metrics  
* Traces  
* Alerts  
* Incidents  
* AI incident analysis

---

# **170\. FAZ 10 — REMOTE WORKSPACE**

* Cloud workspace  
* Web IDE  
* VS Code connection  
* Workspace scheduler  
* Windows/macOS agent

---

# **171\. FAZ 11 — AUTOMATION**

* Natural language actions  
* Durable workflows  
* Advanced policies  
* Automatic dependency updates  
* Scheduled maintenance  
* Proactive AI

---

# **172\. FAZ 12 — AUTONOMOUS PROJECT HUB**

Nihai çalışma:

Observe  
↓  
Understand  
↓  
Recommend  
↓  
Prepare  
↓  
Test  
↓  
Validate  
↓  
Request Approval  
↓  
Execute  
↓  
Observe Again

Düşük riskli işlemlerde approval policy ile kaldırılabilir.

---

# **173\. GERÇEK UÇTAN UCA SENARYO**

Müşteri yeni checkout tasarımına bakmak istiyor.

Developer Project Hub'a girer.

**Create Review**

der.

Project Hub:

Builds project

Creates isolated preview

Runs security scan

Runs responsive tests

Review linki oluşur.

Müşteri linke girer.

Login yapmaz.

Mobile görünüm seçer.

Checkout butonuna tıklar.

Feedback bırakır:

> Bu buton biraz daha büyük olabilir mi?

Project Hub otomatik:

* URL  
* screenshot  
* viewport  
* element  
* project version

bilgilerini kaydeder.

AI feedback'i analiz eder.

Öneri:

> Mobil checkout CTA minimum height artırılabilir.

Project Manager:

**Prepare Fix with AI**

der.

AI:

* Branch açar  
* Kod değiştirir  
* Test ekler  
* Build alır  
* Security scan yapar  
* Yeni preview oluşturur

Project Hub:

AI Fix Ready

Files changed: 2

Tests: 38 passed

Security: Passed

Responsive: 20/20 passed

der.

Developer preview'u açar.

Onaylar.

Müşteri linkinde:

**New version available**

çıkar.

Müşteri yeni versiyona bakar.

**Approved**

der.

Developer:

**Deploy Production**

der.

Project Hub:

* Permission kontrol eder  
* Backup alır  
* Migration kontrol eder  
* Deploy eder  
* Health check yapar  
* Smoke test çalıştırır

Production sağlıklıysa release tamamlanır.

Feedback otomatik:

**Resolved**

olur.

Project Timeline:

Customer Feedback  
↓  
AI Fix  
↓  
Review  
↓  
Approval  
↓  
Production

olarak bütün süreci saklar.

---

# **174\. MANAGER GEREKSİNİM İZLENEBİLİRLİĞİ**

| Manager Gereksinimi | Project Hub Karşılığı |
| ----- | ----- |
| Web tabanlı | Web Control Plane |
| Merkezi proje | Project Repository |
| Localde tutmamak | Server-side Git / Remote Workspace |
| Folder detayları | File Explorer \+ Project Manifest |
| Ön izleme | Preview Engine |
| Web server mantığı | Container \+ Reverse Proxy |
| Kişiye bağımlı olmamak | Central Repository |
| PostgreSQL | Primary Database |
| Demo görüntüsü | Preview \+ Screenshots |
| GitLab/GitHub mantığı | Forgejo \+ Project Hub UI |
| FTP motoru | Deployment Adapter |
| Local API/path/user/pass | Deployment Profiles \+ Agent |
| Versiyon | Version Engine |
| Update modülü | Safe Update Engine |
| Veriyi korumak | Backup \+ Migration |
| Kullanıcı profili | User Management |
| Yetkiler | RBAC \+ Policy |
| Simulator | Simulator Engine |
| 15–20 cihaz | Device Profiles |
| Modüler yapı | Modular Architecture |
| Kaynak kod tarama | Source Scanner |
| Güvenlik açıkları | Security Engine |
| AI bot | Project Brain |
| AI önerileri | L1/L2 |
| AI yönetimi | L3–L5 |
| Proje arşivi | Archive |
| Windows | Local Agent |
| macOS | Local Agent |
| Codex benzeri erişim | AI Workspace |
| Uzaktan müdahale | Remote Workspace / Agent |
| Kendi kendini yöneten yapı | Autonomous Phase |
| 8 GB RAM | Resource-Constrained Architecture |
| 200 GB disk | Retention \+ Storage Policies |
| Local simulator | Local Agent Simulator |
| Müşteri preview | Review Portal |
| Geçici URL | Review Token |
| Login istememesi | Token Based Guest Access |
| Feedback | Visual Feedback |
| Canlı destek | Review Chat |
| Maddeler halinde iş | Feedback → Tasks |
| Hotfix | Hotfix Workflow |
| Link bitiş zamanı | TTL / Expiration |
| Linki manuel kapatma | Revoke |

---

# **175\. PROJENİN ANA BAŞARI KRİTERİ**

Project Hub başarılı sayılmak için kullanıcıya yalnız özellik sunmamalıdır.

Şu senaryoyu gerçekleştirebilmelidir:

> “Bir proje sisteme geldiğinde Project Hub projenin ne olduğunu anlayabilmeli, kaynaklarını merkezi tutabilmeli, projeyi çalıştırabilmeli, görüntüleyebilmeli, müşteriye gösterebilmeli, feedback toplayabilmeli, güvenli şekilde değiştirebilmeli, test edebilmeli, versiyonlayabilmeli, yayınlayabilmeli, sorun çıktığında teşhis edebilmeli ve bütün geçmişini hatırlayabilmelidir.”

---

# **176\. NİHAİ ÜRÜN TANIMI**

Bu ürün yalnız:

**Project Manager**

değildir.

Yalnız:

**Git Server**

değildir.

Yalnız:

**Deployment Tool**

değildir.

Yalnız:

**AI Coding Assistant**

değildir.

Project Hub bunların merkezde birleştiği:

# **DEVELOPMENT OPERATING SYSTEM**

olacaktır.

Ana yaşam döngüsü:

CREATE  
   ↓  
UNDERSTAND  
   ↓  
DEVELOP  
   ↓  
BUILD  
   ↓  
SCAN  
   ↓  
TEST  
   ↓  
PREVIEW  
   ↓  
REVIEW  
   ↓  
FEEDBACK  
   ↓  
FIX  
   ↓  
VERSION  
   ↓  
DEPLOY  
   ↓  
OBSERVE  
   ↓  
LEARN  
   ↓  
IMPROVE

Ve sistem zaman içerisinde bu döngünün giderek daha büyük bölümünü otomatik yürütecektir.

