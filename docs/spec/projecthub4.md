# **PROJECT HUB 2.0**

## **Technical Implementation Blueprint**

**Doküman Amacı:** Yazılım ekibinin doğrudan geliştirmeye başlayabileceği teknik uygulama planı.

**Bağlı Doküman:** Project Hub 2.0 Master Product, UX, Architecture & Automation Specification

**Ana hedef:**

Product Specification  
        ↓  
Technical Architecture  
        ↓  
Repository Structure  
        ↓  
Database  
        ↓  
API Contracts  
        ↓  
Frontend Screens  
        ↓  
Background Workers  
        ↓  
Git / Build / Preview  
        ↓  
Deployment  
        ↓  
AI  
        ↓  
Security  
        ↓  
Observability  
        ↓  
Autonomous Operations  
---

# **1\. TEKNOLOJİ KARARLARI**

İlk versiyonda kullanılacak ana teknoloji seti:

| Katman | Teknoloji |
| ----- | ----- |
| Monorepo | pnpm Workspace \+ Turborepo |
| Frontend | Next.js \+ TypeScript |
| UI | React \+ Tailwind CSS |
| Server state | TanStack Query |
| Forms | React Hook Form |
| Validation | Zod |
| Backend | NestJS \+ TypeScript |
| Database | PostgreSQL |
| ORM / Query Layer | Drizzle ORM |
| Migration | Drizzle migrations \+ gerektiğinde raw SQL |
| Queue | Redis \+ BullMQ |
| Git | Forgejo |
| Proxy | Traefik |
| Container | Docker |
| Realtime | SSE \+ gerektiğinde WebSocket |
| AI Worker | Python |
| AI API | OpenAI API |
| Browser Automation | Playwright |
| Security Scan | Trivy \+ secret scanning |
| Telemetry | OpenTelemetry |
| Local Agent | Rust/Tauri veya Go — ileri faz |
| Workflow | BullMQ ile başlanır, ileri faz Temporal |
| Secrets | AES-GCM encrypted store, ileri faz Vault |
| Artifact Storage | İlk sürüm local adapter, sonradan S3-compatible |
| Tests | Vitest/Jest \+ Playwright |

---

# **2\. NEDEN BU MİMARİ?**

Başlangıç sunucusu:

8 GB RAM  
200 GB Disk

olduğu için ilk sürümde:

Kubernetes  
çok sayıda mikroservis  
local LLM  
Elasticsearch cluster  
Kafka  
çoklu worker node

kullanılmayacaktır.

İlk mimari:

Modular Monolith  
\+  
Background Workers  
\+  
Git Service  
\+  
Container Runtime

olacaktır.

Ancak modüller ileride fiziksel olarak ayrılabilecek sınırlarla yazılacaktır.

---

# **3\. REPOSITORY YAPISI**

Ana repository:

project-hub/  
│  
├── apps/  
│   │  
│   ├── web/  
│   │   ├── app/  
│   │   ├── components/  
│   │   ├── features/  
│   │   ├── hooks/  
│   │   ├── lib/  
│   │   ├── providers/  
│   │   ├── styles/  
│   │   └── middleware.ts  
│   │  
│   ├── api/  
│   │   └── src/  
│   │       ├── main.ts  
│   │       ├── app.module.ts  
│   │       │  
│   │       ├── common/  
│   │       │   ├── decorators/  
│   │       │   ├── filters/  
│   │       │   ├── guards/  
│   │       │   ├── interceptors/  
│   │       │   ├── pipes/  
│   │       │   └── errors/  
│   │       │  
│   │       └── modules/  
│   │           ├── auth/  
│   │           ├── organizations/  
│   │           ├── users/  
│   │           ├── roles/  
│   │           ├── projects/  
│   │           ├── repositories/  
│   │           ├── builds/  
│   │           ├── previews/  
│   │           ├── reviews/  
│   │           ├── feedback/  
│   │           ├── environments/  
│   │           ├── deployments/  
│   │           ├── versions/  
│   │           ├── databases/  
│   │           ├── backups/  
│   │           ├── secrets/  
│   │           ├── security/  
│   │           ├── ai/  
│   │           ├── monitoring/  
│   │           ├── notifications/  
│   │           ├── audit/  
│   │           ├── integrations/  
│   │           └── system/  
│   │  
│   ├── worker/  
│   │   └── src/  
│   │       ├── queues/  
│   │       ├── processors/  
│   │       ├── jobs/  
│   │       └── services/  
│   │  
│   ├── ai-worker/  
│   │   ├── app/  
│   │   ├── agents/  
│   │   ├── indexing/  
│   │   ├── tools/  
│   │   ├── prompts/  
│   │   └── policies/  
│   │  
│   └── agent/  
│       └── ileri-faz  
│  
├── packages/  
│   │  
│   ├── database/  
│   │   ├── src/  
│   │   │   ├── schema/  
│   │   │   ├── relations/  
│   │   │   ├── repositories/  
│   │   │   ├── migrations/  
│   │   │   └── client.ts  
│   │   └── drizzle.config.ts  
│   │  
│   ├── contracts/  
│   │   ├── auth/  
│   │   ├── projects/  
│   │   ├── builds/  
│   │   ├── previews/  
│   │   └── common/  
│   │  
│   ├── ui/  
│   │   ├── button/  
│   │   ├── modal/  
│   │   ├── drawer/  
│   │   ├── table/  
│   │   ├── badge/  
│   │   ├── form/  
│   │   └── navigation/  
│   │  
│   ├── config/  
│   ├── logger/  
│   ├── events/  
│   └── permissions/  
│  
├── infrastructure/  
│   │  
│   ├── docker/  
│   │   ├── api.Dockerfile  
│   │   ├── web.Dockerfile  
│   │   ├── worker.Dockerfile  
│   │   └── ai-worker.Dockerfile  
│   │  
│   ├── traefik/  
│   │   ├── traefik.yml  
│   │   └── dynamic/  
│   │  
│   ├── postgres/  
│   │   └── init/  
│   │  
│   ├── forgejo/  
│   │  
│   └── scripts/  
│  
├── docker-compose.yml  
├── docker-compose.dev.yml  
├── .env.example  
├── package.json  
├── pnpm-workspace.yaml  
├── turbo.json  
├── tsconfig.base.json  
└── README.md  
---

# **4\. FRONTEND ROUTE YAPISI**

Next.js App Router:

apps/web/app/

(auth)/  
    login/  
    forgot-password/

(app)/  
    page.tsx

    projects/  
        page.tsx

        new/  
            page.tsx

        \[projectId\]/  
            page.tsx

            code/  
            branches/  
            commits/  
            pull-requests/

            builds/

            previews/

            simulator/

            environments/

            deployments/

            versions/

            database/

            secrets/

            reviews/

            feedback/

            ai/

            security/

            observability/  
                logs/  
                metrics/  
                traces/  
                incidents/

            documentation/

            activity/

            settings/

admin/  
    page.tsx

    users/  
    teams/  
    roles/  
    projects/  
    infrastructure/  
    deployments/  
    security/  
    ai/  
    backups/  
    audit/  
    integrations/  
    settings/

review/  
    \[token\]/  
        page.tsx  
---

# **5\. FRONTEND FEATURE YAPISI**

Sayfaların business logic'i doğrudan `page.tsx` içerisine doldurulmayacaktır.

Örneğin:

features/projects/

api/  
    create-project.ts  
    get-project.ts  
    get-projects.ts

components/  
    project-card.tsx  
    project-header.tsx  
    project-health.tsx  
    project-status.tsx

hooks/  
    use-project.ts  
    use-projects.ts

schemas/  
    project.schema.ts

types/  
    project.types.ts  
---

# **6\. BACKEND MODÜL STANDARDI**

Her NestJS modülü aynı yapıyı takip eder.

Örneğin:

modules/projects/

projects.module.ts  
projects.controller.ts  
projects.service.ts

dto/  
    create-project.dto.ts  
    update-project.dto.ts  
    project-query.dto.ts

policies/  
    project.policy.ts

events/  
    project-created.event.ts  
    project-archived.event.ts

listeners/  
    project-created.listener.ts

mappers/  
    project.mapper.ts

Database erişimi controller'dan doğrudan yapılmaz.

Akış:

Controller  
    ↓  
Service  
    ↓  
Repository  
    ↓  
Database  
---

# **7\. DOMAIN SINIRLARI**

Örneğin `ProjectService` deployment yapmaz.

Yanlış:

ProjectService.deployProject()

Doğru:

DeploymentService.createDeployment()

Project yalnız:

project identity  
project metadata  
project membership  
project configuration

yönetir.

---

# **8\. DOCKER MİMARİSİ**

Başlangıç:

Internet  
   │  
   ▼  
Traefik  
   │  
   ├──────── web  
   │  
   ├──────── api  
   │  
   ├──────── review  
   │  
   └──────── forgejo  
             │  
             │  
       Internal Network  
             │  
       ┌─────┼─────────────┐  
       ▼     ▼             ▼  
   PostgreSQL Redis      Worker  
                           │  
                           ▼  
                     Runtime / Jobs  
---

# **9\. DOCKER COMPOSE SERVİSLERİ**

İlk ana compose:

traefik

web

api

worker

postgres

redis

forgejo

İleri faz:

ai-worker

preview-runtime

build-runner

security-worker

telemetry-collector  
---

# **10\. DOCKER NETWORKLERİ**

Üç ağ:

edge  
app  
data

### **edge**

Traefik ile public servisler.

### **app**

API, Web, Worker, Forgejo.

### **data**

PostgreSQL ve Redis.

PostgreSQL public internete açılmaz.

Redis public internete açılmaz.

---

# **11\. DIŞARI AÇILACAK PORTLAR**

Production:

80  
443

Opsiyonel Git SSH:

2222

PostgreSQL:

5432

yalnız internal Docker network.

Redis:

6379

yalnız internal network.

---

# **12\. DOCKER VOLUME'LARI**

postgres\_data

forgejo\_data

redis\_data

artifact\_data

backup\_data

traefik\_certificates

Preview container filesystem'i kalıcı olmak zorunda değildir.

---

# **13\. BAŞLANGIÇ RESOURCE BUDGET**

Yaklaşık limit:

| Servis | RAM üst sınırı |
| ----- | ----- |
| PostgreSQL | 2 GB |
| API | 768 MB |
| Web | 512 MB |
| Forgejo | 1 GB |
| Redis | 384 MB |
| Worker | 768 MB |
| Traefik | 256 MB |

Build sırasında ayrıca sınırlı geçici kaynak kullanılır.

Aynı anda başlangıçta:

1 heavy build

çalıştırılması önerilir.

---

# **14\. ENVIRONMENT DOSYALARI**

Repository'ye secret konmaz.

Dosyalar:

.env.example

.env.development

.env.test

.env.production

`.env.production` repository'ye commit edilmez.

---

# **15\. ANA ENVIRONMENT VARIABLES**

Örnek:

NODE\_ENV

APP\_URL  
API\_URL  
REVIEW\_BASE\_URL  
PREVIEW\_BASE\_DOMAIN

DATABASE\_URL  
REDIS\_URL

SESSION\_SECRET  
APP\_ENCRYPTION\_KEY

FORGEJO\_URL  
FORGEJO\_API\_URL  
FORGEJO\_ADMIN\_TOKEN

ARTIFACT\_STORAGE\_DRIVER  
ARTIFACT\_STORAGE\_PATH

TRAEFIK\_API\_URL

OPENAI\_API\_KEY

SMTP\_HOST  
SMTP\_PORT  
SMTP\_USER  
SMTP\_PASSWORD

LOG\_LEVEL  
---

# **16\. DATABASE TASARIM PRENSİPLERİ**

ID:

UUID

kullanılır.

Tarih:

timestamptz

kullanılır.

Tabloların çoğunda:

created\_at  
updated\_at

bulunur.

Silinmesi gereken business entity'lerde gerektiğinde:

deleted\_at

kullanılır.

Audit kayıtlarında soft delete uygulanmaz.

---

# **17\. ORGANIZATION TABLOSU**

organizations

id                  uuid PK  
name                varchar(150) NOT NULL  
slug                varchar(100) NOT NULL  
status              varchar(30) NOT NULL  
settings             jsonb NOT NULL DEFAULT '{}'  
created\_at           timestamptz NOT NULL  
updated\_at           timestamptz NOT NULL

Constraint:

UNIQUE(slug)  
---

# **18\. USERS**

users

id                  uuid PK  
email               varchar(255) NOT NULL  
password\_hash       text  
display\_name        varchar(150) NOT NULL  
avatar\_url          text  
status              varchar(30) NOT NULL  
email\_verified\_at   timestamptz  
last\_login\_at       timestamptz  
created\_at          timestamptz NOT NULL  
updated\_at          timestamptz NOT NULL

Constraint:

UNIQUE(lower(email))  
---

# **19\. ORGANIZATION MEMBERS**

organization\_members

organization\_id     uuid FK organizations  
user\_id             uuid FK users  
status              varchar(30)  
joined\_at           timestamptz

Primary key:

organization\_id  
\+  
user\_id  
---

# **20\. ROLES**

roles

id                  uuid PK  
organization\_id     uuid NULL  
key                 varchar(100)  
name                varchar(100)  
description         text  
is\_system           boolean  
created\_at          timestamptz

`organization_id = null` ise built-in system role olabilir.

---

# **21\. PERMISSIONS**

permissions

key                 varchar(150) PK  
group\_name          varchar(100)  
description         text

Örnek:

project.read  
project.create  
project.update  
project.archive

repository.read  
repository.write

build.create

preview.create  
preview.delete

review.create

deployment.staging  
deployment.production

secret.manage

security.read  
security.manage

ai.run  
ai.approve  
---

# **22\. ROLE PERMISSIONS**

role\_permissions

role\_id             uuid FK roles  
permission\_key      varchar FK permissions

Composite primary key kullanılır.

---

# **23\. MEMBER ROLES**

organization\_member\_roles

organization\_id  
user\_id  
role\_id  
---

# **24\. PROJECTS**

projects

id                  uuid PK  
organization\_id     uuid FK  
name                varchar(150)  
slug                varchar(150)  
description         text

status              varchar(30)

project\_type        varchar(50)

repository\_id       uuid nullable

default\_branch      varchar(100)

created\_by          uuid FK users

archived\_at         timestamptz NULL

created\_at          timestamptz  
updated\_at          timestamptz

Constraint:

UNIQUE(organization\_id, slug)

Index:

organization\_id  
status  
created\_at  
---

# **25\. PROJECT MEMBERS**

project\_members

project\_id          uuid FK  
user\_id             uuid FK

role\_id             uuid NULL

created\_at          timestamptz

Unique:

project\_id  
user\_id  
---

# **26\. PROJECT SETTINGS**

project\_settings

project\_id          uuid PK FK  
settings            jsonb  
updated\_at          timestamptz  
---

# **27\. PROJECT MANIFESTS**

project\_manifests

id                  uuid PK  
project\_id          uuid FK  
version             integer  
source              varchar(30)  
content             jsonb  
created\_by          uuid NULL  
created\_at          timestamptz

Source:

manual  
detected  
ai  
repository  
---

# **28\. REPOSITORIES**

repositories

id                  uuid PK  
project\_id          uuid FK  
provider            varchar(50)  
provider\_repo\_id    varchar(255)  
clone\_url           text  
ssh\_url             text  
default\_branch      varchar(100)  
visibility          varchar(30)  
status              varchar(30)  
created\_at          timestamptz  
updated\_at          timestamptz

Provider ilk etapta:

forgejo  
---

# **29\. SESSIONS**

sessions

id                  uuid PK  
user\_id             uuid FK  
token\_hash          text  
ip\_address          inet  
user\_agent          text  
expires\_at          timestamptz  
last\_seen\_at        timestamptz  
created\_at          timestamptz  
revoked\_at          timestamptz NULL

Raw session token database'e yazılmaz.

Hash saklanır.

---

# **30\. AUDIT EVENTS**

audit\_events

id                  uuid PK

organization\_id     uuid  
project\_id          uuid NULL

actor\_type          varchar(30)  
actor\_id            uuid NULL

action              varchar(150)

resource\_type       varchar(100)  
resource\_id         varchar(255)

metadata            jsonb

ip\_address          inet NULL  
user\_agent          text NULL

created\_at          timestamptz

Index:

organization\_id  
project\_id  
actor\_id  
action  
created\_at  
---

# **31\. OUTBOX EVENTS**

Distributed/event based işlemler için:

outbox\_events

id  
event\_type  
aggregate\_type  
aggregate\_id  
payload  
status  
attempts  
available\_at  
created\_at  
processed\_at

Transaction içinde business kayıt ile birlikte event yazılır.

Worker daha sonra event'i işler.

Bu sayede:

project oluşturuldu  
ama Forgejo çağrısı yapılamadı

gibi durumlarda veri kaybolmaz.

---

# **32\. BUILD TABLOLARI**

builds

id  
project\_id  
repository\_id  
branch  
commit\_sha

trigger\_type  
triggered\_by

status

started\_at  
finished\_at

artifact\_id

created\_at

Status:

queued  
running  
passed  
failed  
cancelled  
---

# **33\. BUILD STEPS**

build\_steps

id  
build\_id

step\_key  
name  
sequence

status

started\_at  
finished\_at

exit\_code

summary

Örnek:

checkout  
install  
security  
build  
unit\_test  
artifact  
preview  
---

# **34\. BUILD LOGS**

Raw log PostgreSQL'e sınırsız yazılmamalıdır.

Tabloda:

build\_log\_streams

build\_id  
storage\_key  
byte\_size  
created\_at

Log dosyası artifact storage üzerinde tutulabilir.

---

# **35\. ARTIFACTS**

artifacts

id  
organization\_id  
project\_id

type

storage\_driver  
storage\_key

file\_name  
content\_type  
size\_bytes  
checksum

retention\_until

created\_at

Type:

build  
release  
screenshot  
report  
backup  
log  
sbom  
---

# **36\. PREVIEWS**

previews

id  
project\_id  
build\_id

slug  
url

status

container\_ref

source\_branch  
source\_commit

expires\_at  
stopped\_at

created\_by  
created\_at

Status:

queued  
building  
starting  
healthy  
failed  
stopped  
expired  
---

# **37\. DEVICE PROFILES**

device\_profiles

id  
name  
category

viewport\_width  
viewport\_height

device\_scale\_factor

user\_agent

is\_default  
is\_active  
---

# **38\. ENVIRONMENTS**

environments

id  
project\_id

name  
slug  
type

url

status

current\_version\_id

created\_at  
updated\_at

Type:

development  
staging  
production  
custom  
---

# **39\. DEPLOYMENT TARGETS**

deployment\_targets

id  
environment\_id

adapter\_type

host  
port

remote\_path

credential\_secret\_id

configuration

created\_at  
updated\_at

Adapter:

sftp  
ssh  
rsync  
docker  
docker-compose  
api  
kubernetes  
---

# **40\. DEPLOYMENTS**

deployments

id

project\_id  
environment\_id  
version\_id

source\_commit

status

requested\_by

approved\_by

started\_at  
finished\_at

previous\_deployment\_id

created\_at  
---

# **41\. DEPLOYMENT STEPS**

deployment\_steps

id  
deployment\_id

step\_key  
sequence

status  
started\_at  
finished\_at

output\_summary  
---

# **42\. VERSIONS**

versions

id  
project\_id

version\_number

commit\_sha  
build\_id

status

release\_notes

created\_by  
created\_at  
released\_at

Constraint:

UNIQUE(project\_id, version\_number)  
---

# **43\. DATABASE CONNECTIONS**

database\_connections

id  
project\_id  
environment\_id

database\_type

host  
port  
database\_name

username\_secret\_id  
password\_secret\_id

ssl\_mode

created\_at  
updated\_at

Password düz metin olarak tutulmaz.

---

# **44\. MIGRATIONS**

migrations

id  
project\_id

migration\_key  
name

checksum  
risk\_level

detected\_at  
applied\_at  
---

# **45\. BACKUPS**

backups

id

project\_id  
environment\_id

type

status

storage\_key  
size\_bytes  
checksum

version\_id  
deployment\_id

created\_at  
verified\_at  
expires\_at  
---

# **46\. SECRET RECORDS**

İlk sürüm:

secrets

id  
organization\_id  
project\_id NULL

name  
scope

encrypted\_value  
encryption\_iv  
auth\_tag

created\_by

created\_at  
updated\_at  
rotated\_at

Application loglarına secret değeri kesinlikle yazılmaz.

---

# **47\. REVIEW SESSIONS**

review\_sessions

id  
project\_id  
preview\_id

name

status

token\_hash

expires\_at  
revoked\_at

created\_by  
created\_at

last\_access\_at  
access\_count

Token raw hali yalnız oluşturulurken kullanıcıya döndürülür.

---

# **48\. FEEDBACK**

feedback

id  
review\_session\_id  
project\_id

feedback\_number

title  
body

status  
priority  
category

page\_url

viewport\_width  
viewport\_height

browser  
operating\_system

x\_coordinate  
y\_coordinate

dom\_selector

version\_id  
build\_id

assigned\_user\_id

created\_at  
updated\_at  
resolved\_at  
---

# **49\. FEEDBACK ATTACHMENTS**

feedback\_attachments

id  
feedback\_id

artifact\_id

attachment\_type

created\_at  
---

# **50\. FEEDBACK COMMENTS**

feedback\_comments

id  
feedback\_id

author\_type  
author\_id

body

created\_at

Author type:

user  
customer  
ai  
---

# **51\. AI TASKS**

ai\_tasks

id  
project\_id

task\_type

title  
instruction

status

requested\_by

autonomy\_level

source\_context

started\_at  
completed\_at

created\_at  
---

# **52\. AI RUNS**

ai\_runs

id  
ai\_task\_id

agent\_type

model

input\_tokens  
output\_tokens

status

started\_at  
finished\_at

error\_code  
---

# **53\. AI ACTIONS**

ai\_actions

id  
ai\_run\_id

action\_type

resource\_type  
resource\_id

payload

risk\_level

requires\_approval

approval\_status

executed\_at  
created\_at  
---

# **54\. SECURITY SCANS**

security\_scans

id  
project\_id  
build\_id NULL

scan\_type

status

started\_at  
finished\_at

summary  
created\_at  
---

# **55\. SECURITY FINDINGS**

security\_findings

id  
security\_scan\_id  
project\_id

severity  
finding\_type

title  
description

file\_path  
line\_number

package\_name  
package\_version

cve

status

fingerprint

created\_at  
resolved\_at  
---

# **56\. INCIDENTS**

incidents

id  
project\_id  
environment\_id

title

severity  
status

started\_at  
resolved\_at

root\_cause

created\_at  
updated\_at  
---

# **57\. API STANDARDI**

Base:

/api/v1

Başarılı response:

{  
  "data": {},  
  "meta": {}  
}

Hata:

{  
  "error": {  
    "code": "PROJECT\_NOT\_FOUND",  
    "message": "Project not found",  
    "requestId": "req\_..."  
  }  
}  
---

# **58\. PAGINATION**

Büyük listelerde offset yerine cursor tercih edilir.

Request:

GET /projects?limit=25\&cursor=abc

Response:

{  
  "data": \[\],  
  "meta": {  
    "nextCursor": "xyz",  
    "hasMore": true  
  }  
}  
---

# **59\. AUTH API**

### **Login**

POST /api/v1/auth/login

Request:

{  
  "email": "user@company.com",  
  "password": "..."  
}

Response:

{  
  "data": {  
    "user": {  
      "id": "...",  
      "displayName": "..."  
    }  
  }  
}

Session:

Secure HTTP-only cookie.

---

# **60\. CURRENT USER**

GET /api/v1/auth/me

Response:

{  
  "data": {  
    "user": {},  
    "organizations": \[\],  
    "permissions": \[\]  
  }  
}  
---

# **61\. LOGOUT**

POST /api/v1/auth/logout

Session revoke edilir.

---

# **62\. PROJECT CREATE API**

POST /api/v1/projects

Permission:

project.create

Request:

{  
  "name": "CRM",  
  "slug": "crm",  
  "description": "Internal CRM",  
  "sourceType": "new",  
  "defaultBranch": "main"  
}

Response:

{  
  "data": {  
    "id": "...",  
    "name": "CRM",  
    "slug": "crm",  
    "status": "initializing"  
  }  
}

Errors:

VALIDATION\_ERROR  
PERMISSION\_DENIED  
PROJECT\_SLUG\_EXISTS  
---

# **63\. PROJECT LIST API**

GET /api/v1/projects

Filters:

status  
team  
search  
technology  
---

# **64\. PROJECT DETAIL**

GET /api/v1/projects/:projectId  
---

# **65\. PROJECT UPDATE**

PATCH /api/v1/projects/:projectId

Permission:

project.update  
---

# **66\. PROJECT ARCHIVE**

POST /api/v1/projects/:projectId/archive

Project fiziksel olarak silinmez.

---

# **67\. REPOSITORY PROVISION**

POST /api/v1/projects/:projectId/repository

API doğrudan Forgejo'yu çağırmak yerine service \+ outbox kullanılabilir.

Flow:

Request  
↓  
ProjectRepository record  
↓  
RepositoryProvisionRequested  
↓  
Worker  
↓  
Forgejo  
↓  
RepositoryProvisioned  
---

# **68\. BUILD CREATE**

POST /api/v1/projects/:projectId/builds

Request:

{  
  "branch": "main",  
  "commitSha": "optional"  
}

Response:

{  
  "data": {  
    "buildId": "...",  
    "status": "queued"  
  }  
}  
---

# **69\. BUILD LOG STREAM**

GET /api/v1/builds/:buildId/events

SSE.

Events:

build.started  
build.step.started  
build.log  
build.step.completed  
build.failed  
build.completed  
---

# **70\. PREVIEW CREATE**

POST /api/v1/projects/:projectId/previews

Request:

{  
  "buildId": "...",  
  "ttlMinutes": 1440  
}  
---

# **71\. PREVIEW STOP**

POST /api/v1/previews/:previewId/stop  
---

# **72\. CREATE REVIEW**

POST /api/v1/projects/:projectId/reviews

Request:

{  
  "previewId": "...",  
  "expiresInMinutes": 1440,  
  "feedbackEnabled": true,  
  "chatEnabled": true  
}

Response:

{  
  "data": {  
    "id": "...",  
    "url": "https\://review.company.com/r/...",  
    "expiresAt": "..."  
  }  
}  
---

# **73\. PUBLIC REVIEW ENDPOINT**

GET /api/v1/public/reviews/:token

Bu endpoint internal login gerektirmez.

Token validation yapılır.

---

# **74\. PUBLIC FEEDBACK**

POST /api/v1/public/reviews/:token/feedback

Request:

{  
  "body": "Button should be larger",  
  "pageUrl": "/checkout",  
  "viewport": {  
    "width": 390,  
    "height": 844  
  },  
  "coordinates": {  
    "x": 311,  
    "y": 622  
  },  
  "domSelector": "\#checkout-button"  
}  
---

# **75\. DEPLOYMENT CREATE**

POST /api/v1/projects/:projectId/deployments

Request:

{  
  "environmentId": "...",  
  "versionId": "..."  
}

Deployment ilk önce:

pending\_validation

durumuna gelir.

---

# **76\. DEPLOYMENT APPROVAL**

POST /api/v1/deployments/:deploymentId/approve  
---

# **77\. DEPLOYMENT ROLLBACK**

POST /api/v1/deployments/:deploymentId/rollback  
---

# **78\. AI PROJECT QUERY**

POST /api/v1/projects/:projectId/ai/query

Request:

{  
  "message": "Login sistemi nasıl çalışıyor?"  
}  
---

# **79\. AI FIX**

POST /api/v1/feedback/:feedbackId/ai-fix

AI doğrudan main branch'e yazamaz.

Sonuç:

AI Task  
\+  
Workspace  
\+  
Branch

oluşturulur.

---

# **80\. SECURITY SCAN**

POST /api/v1/projects/:projectId/security/scans  
---

# **81\. FRONTEND → API EŞLEMESİ**

## **Login**

Route:

/login

API:

POST /auth/login  
GET /auth/me  
---

## **Dashboard**

Route:

/

API:

GET /dashboard  
GET /tasks  
GET /notifications  
---

## **Projects**

/projects

API:

GET /projects  
---

## **New Project**

/projects/new

API:

POST /projects  
POST /projects/:id/repository  
POST /projects/:id/detect  
---

## **Project Overview**

/projects/:id

API:

GET /projects/:id  
GET /projects/:id/health  
GET /projects/:id/activity  
---

## **Code**

/projects/:id/code

API:

GET /projects/:id/repository/tree  
GET /projects/:id/repository/files  
---

## **Builds**

/projects/:id/builds

API:

GET /projects/:id/builds  
POST /projects/:id/builds  
---

## **Preview**

/projects/:id/previews

API:

GET /projects/:id/previews  
POST /projects/:id/previews  
---

## **Simulator**

/projects/:id/simulator

API:

GET /device-profiles  
GET /projects/:id/previews  
POST /preview-tests  
---

## **Reviews**

/projects/:id/reviews

API:

GET /projects/:id/reviews  
POST /projects/:id/reviews  
---

## **Feedback**

/projects/:id/feedback

API:

GET /projects/:id/feedback  
PATCH /feedback/:id  
POST /feedback/:id/ai-fix  
---

## **Deployment**

/projects/:id/deployments

API:

GET /projects/:id/deployments  
POST /projects/:id/deployments  
---

# **82\. EVENT STANDARDI**

Event adı:

domain.entity.action

Örnek:

project.created

repository.provision.requested

repository.provision.completed

build.queued

build.started

build.completed

build.failed

preview.created

preview.expired

review.created

feedback.created

ai.task.created

ai.task.completed

deployment.started

deployment.completed

deployment.failed

security.finding.created  
---

# **83\. EVENT ENVELOPE**

{  
  "eventId": "...",  
  "eventType": "project.created",  
  "occurredAt": "...",  
  "organizationId": "...",  
  "projectId": "...",  
  "actor": {  
    "type": "user",  
    "id": "..."  
  },  
  "payload": {}  
}  
---

# **84\. QUEUE YAPISI**

Başlangıç queue'ları:

default

git

build

preview

deployment

security

ai

notification

maintenance  
---

# **85\. JOB STANDARDI**

Örneğin:

build.execute

Payload:

{  
  "buildId": "...",  
  "projectId": "...",  
  "repositoryId": "...",  
  "commitSha": "..."  
}  
---

# **86\. JOB RETRY**

Her job sonsuz retry yapmaz.

Örneğin:

attempts: 3

Backoff:

30 sec  
2 min  
10 min

Deployment bazı aşamalarda otomatik retry edilmemelidir.

---

# **87\. IDEMPOTENCY**

Kritik job'lar tekrar çalıştırılabilir tasarlanmalıdır.

Örneğin:

repository.provision

iki kere çalışırsa iki repository oluşturmamalıdır.

---

# **88\. BUILD PIPELINE**

Gerçek sequence:

BuildRequested

↓  
Resolve Repository

↓  
Checkout Commit

↓  
Read Project Manifest

↓  
Prepare Isolated Workspace

↓  
Install Dependencies

↓  
Source Security Scan

↓  
Build

↓  
Unit Tests

↓  
Artifact Creation

↓  
Store Artifact

↓  
Finalize Build  
---

# **89\. BUILD WORKSPACE**

Her build ayrı:

/builds/{buildId}

workspace kullanır.

Build bittikten sonra policy'ye göre temizlenir.

---

# **90\. BUILD SECURITY**

Build process:

* API process ile aynı user altında çalışmaz.  
* Host filesystem'e sınırsız erişmez.  
* Resource limit uygulanır.  
* Network access gerektiğinde sınırlandırılır.  
* Build secret'ları sadece gerekli scope'a verilir.

---

# **91\. PREVIEW FLOW**

Build  
↓  
Artifact  
↓  
PreviewCreateRequested  
↓  
Container Create  
↓  
Dynamic Hostname  
↓  
Traefik Route  
↓  
Health Check  
↓  
Ready

Örnek hostname:

p-42-b-883.preview.company.com  
---

# **92\. PREVIEW TTL WORKER**

Maintenance worker belirli aralıklarla:

expires\_at \< NOW  
AND status \= healthy

preview'ları bulur.

Ardından:

stop container  
remove route  
mark expired

yapar.

---

# **93\. CUSTOMER REVIEW GÜVENLİĞİ**

Review URL doğrudan preview container kimliğini açığa çıkarmaz.

Akış:

Review Token  
↓  
Review Gateway  
↓  
Authorized Preview

Session revoke edilirse preview açık olsa bile müşteri erişemez.

---

# **94\. FEEDBACK SCREENSHOT FLOW**

Customer clicks point  
↓  
Browser captures context  
↓  
Screenshot  
↓  
Artifact upload  
↓  
Feedback record  
↓  
Attachment link  
---

# **95\. DEPLOYMENT PIPELINE**

Deployment Requested

↓  
Permission Check

↓  
Policy Check

↓  
Version Validation

↓  
Test Verification

↓  
Security Verification

↓  
Backup

↓  
Migration Plan

↓  
Deployment Adapter

↓  
Health Check

↓  
Smoke Test

↓  
Finalize Release  
---

# **96\. DEPLOYMENT ADAPTER INTERFACE**

Backend:

interface DeploymentAdapter {  
  validate(config: DeploymentConfig): Promise\<ValidationResult\>;

  deploy(context: DeploymentContext): Promise\<DeploymentResult\>;

  rollback(context: RollbackContext): Promise\<RollbackResult\>;

  healthCheck(context: DeploymentContext): Promise\<HealthResult\>;  
}

Implementasyonlar:

SftpDeploymentAdapter

SshDeploymentAdapter

DockerDeploymentAdapter

DockerComposeDeploymentAdapter  
---

# **97\. FTP KONUSU**

Manager'ın FTP motoru gereksinimi korunur.

Ancak:

FTP

yerine mümkünse:

SFTP

varsayılan olur.

Plain FTP:

Legacy Mode

olarak ayrıca açılır.

---

# **98\. AI MİMARİSİ**

AI backend ana uygulama içine tamamen gömülmez.

NestJS API  
    ↓  
AI Task  
    ↓  
ai queue  
    ↓  
Python AI Worker  
---

# **99\. AI AGENTS**

ProjectManagerAgent

ArchitectAgent

CodeAgent

QAAgent

SecurityAgent

DatabaseAgent

DevOpsAgent

FrontendAgent

DocumentationAgent  
---

# **100\. AI TOOL'LARI**

Agent doğrudan shell'e sınırsız erişmez.

Tool API üzerinden:

read\_file

search\_code

list\_tree

read\_git\_diff

create\_branch

write\_file

run\_test

run\_build

create\_preview

read\_logs

create\_task

kullanır.

---

# **101\. AI POLICY CHECK**

Her AI action:

AI Request  
↓  
Policy  
↓  
Risk Classification  
↓  
Allowed?

Örneğin:

read source  
LOW  
AUTO

write branch  
MEDIUM  
ALLOW

merge main  
HIGH  
APPROVAL

production deploy  
CRITICAL  
HUMAN APPROVAL  
---

# **102\. AI WORKSPACE**

AI task:

AI-184

oluştuğunda:

ai/AI-184

branch açılır.

AI değişikliklerini burada gerçekleştirir.

---

# **103\. AI'NIN MAIN BRANCH'E DOĞRUDAN YAZMASI**

Yasaktır.

Flow:

AI Branch  
↓  
Build  
↓  
Tests  
↓  
Security  
↓  
Preview  
↓  
Human Review  
↓  
Merge  
---

# **104\. SECURITY PIPELINE**

Source Scan  
↓  
Dependency Scan  
↓  
Secret Scan  
↓  
Build  
↓  
Container Scan  
↓  
Policy Evaluation  
---

# **105\. CRITICAL SECURITY POLICY**

Örneğin:

critical\_findings \> 0

ise production deployment:

DENIED

olabilir.

Admin exception tanımlayabilir.

Exception da audit edilir.

---

# **106\. LOGGING STANDARDI**

Her request:

request\_id

alır.

Log:

{  
  "level": "info",  
  "service": "api",  
  "requestId": "...",  
  "userId": "...",  
  "projectId": "...",  
  "event": "project.created"  
}

Secret ve password loglanmaz.

---

# **107\. HEALTH ENDPOINTS**

API:

GET /health/live  
GET /health/ready

`live`:

Process çalışıyor mu?

`ready`:

Database/Redis gibi kritik bağımlılıklar hazır mı?

---

# **108\. FRONTEND COMPONENT HİYERARŞİSİ**

Global:

AppShell

Sidebar

Topbar

CommandPalette

NotificationPanel

GlobalSearch

AIContextDrawer  
---

# **109\. PROJECT PAGE SHELL**

ProjectShell

ProjectHeader

ProjectSidebar

ProjectContext

ProjectContent

ProjectHeader:

Project Name

Environment

Version

Health

Quick Actions  
---

# **110\. ADMIN SHELL**

AdminShell

AdminSidebar

SystemStatus

AdminContent  
---

# **111\. CUSTOMER REVIEW SHELL**

Review portal ayrı shell kullanır.

ReviewShell

ReviewTopbar

PreviewFrame

FeedbackOverlay

FeedbackDrawer

ReviewChat

Admin sidebar burada bulunmaz.

---

# **112\. PERMISSION GUARD**

Frontend permission yalnız UX içindir.

Gerçek security backend'de uygulanır.

Örneğin:

@RequirePermission('deployment.production')

gibi guard kullanılmalıdır.

---

# **113\. MULTI-TENANT QUERY RULE**

Organization scope gerektiren her query:

organization\_id

ile filtrelenmelidir.

Sadece:

WHERE id \= projectId

yapmak yasaktır.

Doğru:

WHERE  
id \= projectId  
AND organization\_id \= currentOrganizationId  
---

# **114\. DATABASE RLS**

İleri güvenlik katmanı olarak PostgreSQL Row-Level Security değerlendirilebilir.

Ancak uygulama permission sistemi yine korunur.

RLS ikinci savunma katmanıdır.

---

# **115\. TEST KATMANLARI**

### **Unit**

service  
policy  
utility

### **Integration**

database  
repository  
queue  
Forgejo client

### **API**

controllers  
permissions  
validation

### **E2E**

login  
create project  
create preview  
create review  
feedback  
deployment  
---

# **116\. CRITICAL E2E SENARYO**

En önemli test:

Admin login  
↓  
Create project  
↓  
Repository provision  
↓  
Create build  
↓  
Preview  
↓  
Review link  
↓  
Customer feedback  
↓  
Internal feedback list

Fazlar ilerledikçe deployment da eklenir.

---

# **117\. CI PIPELINE**

Project Hub'ın kendi repository'sinde:

Install  
↓  
Lint  
↓  
Typecheck  
↓  
Unit Tests  
↓  
Integration Tests  
↓  
Build  
↓  
Security Scan  
---

# **118\. BRANCH STRATEJİSİ**

Öneri:

main

her zaman deploy edilebilir durumda tutulur.

Feature:

feature/PH-123-project-import

Bug:

fix/PH-242-preview-timeout

AI:

ai/AI-184-checkout-feedback  
---

# **119\. MIGRATION STRATEJİSİ**

Migration dosyaları repository'de versioned olur.

Örneğin:

0001\_organizations.sql  
0002\_users.sql  
0003\_permissions.sql  
0004\_projects.sql

Production migration otomatik ama kontrollü workflow üzerinden çalışır.

---

# **120\. DEVELOPMENT BOOTSTRAP**

Yeni developer:

git clone  
pnpm install  
docker compose up postgres redis forgejo  
pnpm db:migrate  
pnpm dev

ile sistemi çalıştırabilmelidir.

---

# **121\. FAZ 1'İN TAM KAPSAMI**

Faz 1'de yalnız şu çekirdek tamamlanmalıdır:

Monorepo

Docker development environment

PostgreSQL

Redis

Forgejo

Authentication

Organizations

Users

Roles

Permissions

Projects

Project Membership

Repository Provisioning

Audit Logs

Admin App Shell

Project App Shell

Build/Preview henüz Faz 1 Definition of Done'a dahil değildir.

---

# **122\. FAZ 1 — DOSYA DOSYA GELİŞTİRME SIRASI**

## **001**

İlk dosya:

package.json

Workspace scriptleri:

dev  
build  
lint  
test  
typecheck  
db:migrate  
---

## **002**

pnpm-workspace.yaml

Workspace'ler tanımlanır.

---

## **003**

turbo.json

Monorepo task dependency graph oluşturulur.

---

## **004**

tsconfig.base.json

Ortak TypeScript config.

---

## **005**

.env.example

Tüm required environment variable isimleri.

---

## **006**

docker-compose.dev.yml

İlk olarak:

postgres  
redis  
forgejo

ayağa kaldırılır.

---

## **007**

packages/database/package.json

Database package oluşturulur.

---

## **008**

packages/database/src/client.ts

PostgreSQL client.

---

## **009**

İlk business schema dosyası:

packages/database/src/schema/organizations.ts

Bu, domain tarafındaki ilk gerçek tablo dosyasıdır.

---

## **010**

packages/database/src/schema/users.ts  
---

## **011**

packages/database/src/schema/organization-members.ts  
---

## **012**

packages/database/src/schema/roles.ts  
---

## **013**

packages/database/src/schema/permissions.ts  
---

## **014**

packages/database/src/schema/role-permissions.ts  
---

## **015**

packages/database/src/schema/member-roles.ts  
---

## **016**

packages/database/src/schema/sessions.ts  
---

## **017**

packages/database/src/schema/projects.ts  
---

## **018**

packages/database/src/schema/project-members.ts  
---

## **019**

packages/database/src/schema/repositories.ts  
---

## **020**

packages/database/src/schema/audit-events.ts  
---

## **021**

packages/database/src/schema/outbox-events.ts  
---

# **123\. İLK MIGRATION**

İlk migration:

0001\_core\_identity.sql

İçerik:

organizations

users

organization\_members

roles

permissions

role\_permissions

organization\_member\_roles

sessions  
---

# **124\. İKİNCİ MIGRATION**

0002\_projects.sql

İçerik:

projects

project\_members

project\_settings

project\_manifests  
---

# **125\. ÜÇÜNCÜ MIGRATION**

0003\_repositories\_audit.sql

İçerik:

repositories

audit\_events

outbox\_events  
---

# **126\. BACKEND BAŞLANGIÇ DOSYALARI**

Sonraki dosya:

apps/api/src/main.ts

Ardından:

apps/api/src/app.module.ts  
---

# **127\. CONFIG MODÜLÜ**

apps/api/src/modules/config/

Environment validation ilk aşamada yapılır.

Server gerekli environment variable yoksa sessizce başlamaz.

---

# **128\. DATABASE MODÜLÜ**

apps/api/src/modules/database/database.module.ts

Database client dependency injection ile kullanılır.

---

# **129\. AUTH MODÜLÜ**

Sıradaki modül:

apps/api/src/modules/auth/

Dosyalar:

auth.module.ts

auth.controller.ts

auth.service.ts

password.service.ts

session.service.ts

guards/  
    authenticated.guard.ts

dto/  
    login.dto.ts  
---

# **130\. İLK ENDPOINT**

Gerçek ilk business endpoint:

GET /api/v1/health

Sonra ilk authentication endpoint:

POST /api/v1/auth/login

Sonra:

GET /api/v1/auth/me  
---

# **131\. USER BOOTSTRAP**

İlk Super Admin CLI üzerinden oluşturulmalıdır.

Script:

scripts/create-admin.ts

Örnek command:

pnpm admin:create

Bu script:

organization  
user  
super\_admin role  
membership

oluşturur.

---

# **132\. PERMISSIONS SEED**

Dosya:

packages/permissions/src/default-permissions.ts

İlk permission listesi burada version-controlled olur.

---

# **133\. PROJECT MODÜLÜ**

Auth tamamlandıktan sonra:

apps/api/src/modules/projects/

oluşturulur.

İlk endpointler:

GET /projects

POST /projects

GET /projects/:id

PATCH /projects/:id  
---

# **134\. REPOSITORY MODÜLÜ**

Sonra:

apps/api/src/modules/repositories/

Dosyalar:

repositories.module.ts  
repositories.service.ts

forgejo/  
    forgejo.client.ts  
    forgejo.types.ts  
---

# **135\. İLK FORGEJO AKIŞI**

Project oluştur:

POST /projects

Sonra:

POST /projects/:id/repository

Bu:

RepositoryProvisionRequested

event'i üretir.

---

# **136\. WORKER KURULUMU**

apps/worker/

oluşturulur.

İlk processor:

repository-provision.processor.ts

Akış:

Queue  
↓  
Forgejo API  
↓  
Repository Created  
↓  
repositories update  
↓  
Audit event  
---

# **137\. FRONTEND BAŞLANGIÇ SIRASI**

Backend core stabil olduktan sonra:

apps/web

başlatılır.

İlk sayfa:

/login  
---

# **138\. FRONTEND'DE İLK COMPONENT**

packages/ui/src/button/button.tsx

Sonra:

input  
form-field  
card  
badge  
dialog  
drawer  
table  
---

# **139\. APP SHELL**

Dosya:

apps/web/components/app-shell/app-shell.tsx

Alt bileşenler:

sidebar.tsx  
topbar.tsx  
organization-switcher.tsx  
user-menu.tsx  
---

# **140\. PROJECT LIST PAGE**

İlk business frontend ekranı:

/projects

Gösterir:

Project Name  
Status  
Repository  
Owner  
Updated  
---

# **141\. NEW PROJECT SCREEN**

Sonraki ekran:

/projects/new

İlk sürüm wizard:

General  
↓  
Source  
↓  
Review

İleri fazda environment/database gibi step'ler eklenir.

---

# **142\. PROJECT DETAIL**

/projects/:id

İlk Faz 1 içeriği:

Name

Description

Status

Repository

Members

Activity  
---

# **143\. ADMIN USER SCREEN**

Sonraki:

/admin/users

Liste ve invite oluşturulur.

---

# **144\. ROLE MANAGEMENT**

/admin/roles

Admin:

role  
permissions

yönetebilir.

---

# **145\. AUDIT SCREEN**

/admin/audit

Filtre:

actor  
project  
action  
date  
---

# **146\. FAZ 1 DEFINITION OF DONE**

Faz 1 tamam sayılmak için:

Super Admin oluşturulabiliyor.

Login çalışıyor.

Session güvenli.

Organization oluşuyor.

User davet edilebiliyor.

Role atanabiliyor.

Permission backend tarafından uygulanıyor.

Project oluşturulabiliyor.

Project listeleniyor.

Project üyeleri yönetilebiliyor.

Forgejo repository provision edilebiliyor.

Project → repository ilişkisi kuruluyor.

Audit kayıtları çalışıyor.

Unauthorized erişim engelleniyor.

Server restart sonrası veri kaybolmuyor.

Admin panel açılıyor.

Project workspace shell açılıyor.  
---

# **147\. FAZ 2 — BUILD & PREVIEW**

Yeni tablolar:

builds  
build\_steps  
artifacts  
previews

Yeni queue:

build  
preview

Yeni ekran:

Builds  
Preview  
---

# **148\. FAZ 2 İLK IMPLEMENTATION**

Sıra:

Build schema

Build API

Build queue

Build worker

Build logs

Artifact storage

Preview schema

Preview runtime

Traefik dynamic routing

Preview UI

TTL cleanup  
---

# **149\. FAZ 3 — CUSTOMER REVIEW**

Sıra:

review\_sessions

review\_tokens

feedback

feedback\_comments

review portal

feedback overlay

screenshot upload

feedback dashboard

review expiration  
---

# **150\. FAZ 4 — SIMULATOR**

Sıra:

device\_profiles

simulator UI

viewport switching

rotation

screenshots

Playwright test runner

multi-device test

visual regression  
---

# **151\. FAZ 5 — DEPLOYMENT**

Sıra:

environments

deployment\_targets

versions

deployments

deployment\_steps

secret store

backup system

SFTP adapter

SSH adapter

Docker adapter

approval flow

rollback  
---

# **152\. FAZ 6 — AI PROJECT BRAIN**

Sıra:

ai\_tasks

ai\_runs

code indexing

repository search

project context builder

AI Q\&A

build failure analysis

feedback classification

documentation assistant  
---

# **153\. FAZ 7 — SECURITY**

security\_scans

security\_findings

Trivy

secret scanner

dependency scanner

security score

deployment policy  
---

# **154\. FAZ 8 — AI CODING**

AI workspace

AI branch creation

write\_file tool

test tool

build tool

preview tool

diff review

approval

merge  
---

# **155\. FAZ 9 — OBSERVABILITY**

OpenTelemetry

logs

metrics

traces

alerts

incidents

AI incident analysis  
---

# **156\. FAZ 10 — LOCAL AGENT**

Repository:

apps/agent

Agent:

pair device

allow folders

file transfer

local preview

browser testing

restricted command execution  
---

# **157\. FAZ 11 — REMOTE WORKSPACE**

Workspace entity

workspace runtime

IDE connection

idle shutdown

resource limits

workspace secrets  
---

# **158\. FAZ 12 — AUTONOMOUS OPERATIONS**

Policy engine

AI autonomy levels

self-healing actions

automatic dependency upgrade

automatic staging validation

proactive maintenance

scheduled optimization  
---

# **159\. SCREEN ACCEPTANCE CRITERIA STANDARDI**

Her ekran geliştirilmeden önce ticket şu formatta olmalıdır:

Screen

Purpose

Route

Permissions

API Dependencies

States

Actions

Error States

Loading States

Empty State

Responsive Behavior

Audit Actions

Acceptance Criteria  
---

# **160\. ÖRNEK — PROJECT LIST ACCEPTANCE**

Screen:

Projects

Route:

/projects

Permission:

project.read

Acceptance:

Kullanıcı yalnız erişebildiği projeleri görür.

Search çalışır.

Archived filtre çalışır.

Loading state vardır.

Empty state vardır.

API error olduğunda retry gösterilir.

Project adına tıklanınca project detail açılır.

project.read izni olmayan kullanıcı endpoint'ten de veri alamaz.  
---

# **161\. API ACCEPTANCE STANDARDI**

Her endpoint için:

Authentication

Permission

Input validation

Business validation

Database transaction

Audit

Error contract

Tests

zorunludur.

---

# **162\. SERVICE ACCEPTANCE STANDARDI**

Her service:

* Controller'dan bağımsız test edilebilir.  
* Global request objesine bağımlı olmaz.  
* Database transaction açıkça yönetilir.  
* Cross-domain işlemlerde event kullanır.  
* Secret loglamaz.  
* Organization scope uygular.

---

# **163\. DATABASE ACCEPTANCE STANDARDI**

Her yeni tablo için:

PK

FK

NOT NULL

Unique constraint

Required indexes

Delete behavior

Organization scope

Audit impact

Migration

Rollback plan

tanımlanmalıdır.

---

# **164\. FEATURE BRANCH'TEN MERGE'E KADAR**

Her feature:

Ticket  
↓  
Branch  
↓  
Implementation  
↓  
Unit Test  
↓  
Integration Test  
↓  
Lint  
↓  
Typecheck  
↓  
PR  
↓  
Review  
↓  
Merge  
---

# **165\. FAZ 1 TICKET SIRASI**

Gerçek issue board başlangıcı:

PH-001 Bootstrap monorepo

PH-002 Docker development environment

PH-003 Database package

PH-004 Core identity schema

PH-005 Migration runner

PH-006 Super admin bootstrap

PH-007 Authentication module

PH-008 Session management

PH-009 Permission engine

PH-010 Organization module

PH-011 User management

PH-012 Role management

PH-013 Project schema

PH-014 Project API

PH-015 Project membership

PH-016 Forgejo service

PH-017 Repository provisioning

PH-018 Outbox worker

PH-019 Audit engine

PH-020 Web application shell

PH-021 Login UI

PH-022 Project list UI

PH-023 Project creation UI

PH-024 Project detail UI

PH-025 Admin user UI

PH-026 Role & permission UI

PH-027 Audit log UI

PH-028 E2E core flow

PH-029 Security hardening

PH-030 Phase 1 release  
---

# **166\. İLK GERÇEK UÇTAN UCA MILESTONE**

İlk milestone'da kullanıcı şu süreci gerçekleştirmelidir:

Open browser

↓  
Login

↓  
Create Project

↓  
Project created in PostgreSQL

↓  
Repository provisioning job

↓  
Forgejo repository created

↓  
Repository linked to Project

↓  
Project Workspace opens

↓  
Audit log contains full flow

Bu milestone çalışmadan build/preview geliştirmesine başlanmamalıdır.

---

# **167\. İKİNCİ UÇTAN UCA MILESTONE**

Project

↓  
Repository

↓  
Build

↓  
Artifact

↓  
Preview

↓  
Browser  
---

# **168\. ÜÇÜNCÜ MILESTONE**

Preview

↓  
Temporary Review URL

↓  
Customer

↓  
Feedback

↓  
Internal Project

↓  
Task  
---

# **169\. DÖRDÜNCÜ MILESTONE**

Feedback

↓  
AI Analysis

↓  
AI Branch

↓  
Fix

↓  
Build

↓  
Preview

↓  
Human Approval  
---

# **170\. BEŞİNCİ MILESTONE**

Approved Version

↓  
Backup

↓  
Deployment

↓  
Migration

↓  
Health Check

↓  
Production  
---

# **171\. NİHAİ TEKNİK AKIŞ**

Sistem olgunlaştığında:

Repository  
    ↓  
Project Intelligence  
    ↓  
Build  
    ↓  
Security  
    ↓  
Tests  
    ↓  
Preview  
    ↓  
Simulator  
    ↓  
Customer Review  
    ↓  
Feedback  
    ↓  
AI / Developer Fix  
    ↓  
Version  
    ↓  
Deployment  
    ↓  
Monitoring  
    ↓  
Incident Analysis  
    ↓  
Knowledge Base  
---

# **172\. BİR DEVELOPER'A VERİLECEK BAŞLANGIÇ TALİMATI**

Developer ilk olarak feature geliştirmeye başlamamalıdır.

İlk görev:

PH-001 Bootstrap Project Hub Monorepo

İlk oluşturulacak dosya:

/package.json

Ardından:

/pnpm-workspace.yaml

/turbo.json

/tsconfig.base.json

/.env.example

/docker-compose.dev.yml

Sonra ilk uygulama altyapısı:

/packages/database  
/apps/api  
/apps/web  
/apps/worker

oluşturulur.

İlk domain dosyası:

/packages/database/src/schema/organizations.ts

İlk API:

GET /api/v1/health

İlk authentication API:

POST /api/v1/auth/login

İlk business API:

POST /api/v1/projects

İlk business frontend sayfası:

/projects

İlk gerçek entegrasyon:

Forgejo Repository Provisioning

İlk uçtan uca kabul testi:

Login  
→ Create Project  
→ Repository Provision  
→ Project Workspace  
→ Audit Log

Bu çalışmadan Faz 2'ye geçilmemelidir.

---

# **173\. BU DOKÜMANIN UYGULAMA KURALI**

Bundan sonra geliştirilecek hiçbir modül yalnız:

> “şöyle bir özellik ekleyelim”

şeklinde ele alınmamalıdır.

Her özellik şu zincirde tanımlanmalıdır:

Requirement

↓  
Screen

↓  
Permission

↓  
API Contract

↓  
Domain Service

↓  
Database

↓  
Event

↓  
Background Job

↓  
Audit

↓  
Test

↓  
Acceptance Criteria

Bu standardın korunması Project Hub büyüdükçe sistemin dağılmasını engelleyecektir.

---

# **174\. SON TEKNİK HEDEF**

Project Hub kod tabanı şu soruların tamamına net cevap verebilmelidir:

Bu özellik hangi modülde?

Hangi kullanıcı kullanabilir?

Hangi ekrandan erişilir?

Hangi endpoint çalışır?

Hangi tablo değişir?

Hangi event oluşur?

Hangi worker çalışır?

Hangi audit kaydı oluşur?

Hangi test bunu garanti eder?

Hata olursa nasıl geri alınır?

AI buna müdahale edebilir mi?

İnsan onayı gerekiyor mu?

Bu soruların herhangi biri cevapsızsa özellik teknik olarak tamamlanmış kabul edilmemelidir.

---

# **175\. PROJECT HUB 2.0 UYGULAMA PRENSİBİ**

Sistem üç temel kuralla geliştirilmelidir:

**Birinci kural: Merkezi kaynak**

Projenin doğru versiyonu kişisel bilgisayar değildir.

Project Hub \+ Git ana kaynaktır.

**İkinci kural: Her şey izlenebilir**

Kod, build, feedback, AI, deployment ve kullanıcı işlemleri geçmişe dönük takip edilebilir olmalıdır.

**Üçüncü kural: Otomasyon kontrollüdür**

AI ve otomasyon işleri hızlandırır ancak yetki, policy, audit ve gerektiğinde insan onayı ile çalışır.

---

# **176\. NİHAİ MİMARİ**

                        PROJECT HUB  
                              │  
           ┌──────────────────┼─────────────────┐  
           │                  │                 │  
           ▼                  ▼                 ▼  
       Admin UI         Project Workspace   Review Portal  
           │                  │                 │  
           └──────────────────┼─────────────────┘  
                              │  
                              ▼  
                         Project Hub API  
                              │  
        ┌───────────────┬─────┼─────┬────────────────┐  
        │               │     │     │                │  
        ▼               ▼     ▼     ▼                ▼  
   PostgreSQL         Redis   Git   Workers         Storage  
                             │      │  
                             │      ├──── Build  
                             │      ├──── Preview  
                             │      ├──── Deploy  
                             │      ├──── Security  
                             │      └──── AI  
                             │  
                             ▼  
                          Forgejo

                              │  
                              ▼  
                     Container Runtime  
                              │  
             ┌────────────────┼───────────────┐  
             ▼                ▼               ▼  
           Builds          Previews       Workspaces

                              │  
                              ▼  
                         Environments  
                              │  
                  ┌───────────┼───────────┐  
                  ▼           ▼           ▼  
                 Dev       Staging     Production

Bu yapı üzerine ilerleyen fazlarda:

AI Project Brain

AI Engineering Team

Security Policies

Observability

Local Agent

Remote Workspaces

Self-Healing

Autonomous Operations

eklenebilir.

Temel mimariyi değiştirmek gerekmez.

