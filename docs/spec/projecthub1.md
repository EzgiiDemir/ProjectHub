# **Proje Kaynak Yönetimi ve Project Hub Sistemi**

## **Projenin Genel Amacı**

Web tabanlı, şirket içerisindeki tüm yazılım projelerinin merkezi olarak yönetilebildiği bir **Proje Kaynak Yönetimi / Project Hub** sistemi oluşturulacaktır.

Sistem; projelerin kaynak kodlarının saklanması, görüntülenmesi, ön izlenmesi, sunucuya aktarılması, versiyonlanması, güncellenmesi, kullanıcı ve yetki yönetimi, güvenlik kontrolleri ve yapay zekâ destekli proje analizi gibi işlevleri tek bir merkezden yönetebilmelidir.

Uzun vadede sistemin bir **Project Hub / Data Hub** mantığında çalışması ve projeler hakkında merkezi bilgi sahibi olan, yönetim süreçlerini büyük ölçüde otomatikleştiren bir platform haline gelmesi hedeflenmektedir.

---

## **1\. Web Tabanlı Merkezi Yapı**

Sistem web tabanlı olacaktır.

Projeler kullanıcıların bilgisayarlarında veya local ortamlarında tutulmayacaktır. Proje dosyaları merkezi sunucu üzerinde saklanacaktır.

Böylece ekip içerisinde:

* "Proje bende",  
* "Dosyalar onun bilgisayarında",  
* "Sen ona bak, ben buna bakayım"

gibi kişiye bağımlı çalışma yapısı ortadan kaldırılacaktır.

Yetkisi olan kullanıcılar sisteme giriş yaptıklarında ilgili projelere merkezi olarak erişebilmelidir.

---

## **2\. Proje Oluşturma ve Proje Yapısı**

Yeni bir proje oluşturulurken sistem aşağıdaki bilgileri yönetebilmelidir:

* Proje adı  
* Proje açıklaması  
* Kullanılan teknoloji / altyapı  
* Çalışacağı ortam  
* Klasör ve dosya yapısı  
* API bilgileri  
* Database bilgileri  
* Deployment bilgileri  
* Sunucu bilgileri  
* Versiyon bilgileri  
* Projeye atanmış kullanıcılar  
* Kullanıcı yetkileri

Projenin hangi tabanda veya hangi teknoloji altyapısında çalışacağı sisteme tanımlanabilmelidir.

---

## **3\. Merkezi Proje Arşivi**

Sistem şirketin tüm proje arşivini yönetebilmelidir.

Eski ve güncel projeler tek bir merkezden görüntülenebilmelidir.

Her proje için:

* Kaynak kodları  
* Dosyalar  
* Versiyonlar  
* Güncellemeler  
* Demo görüntüleri  
* Ön izlemeler  
* Deployment geçmişi  
* Kullanıcı işlemleri  
* AI analizleri  
* Müşteri geri bildirimleri

saklanabilmelidir.

---

## **4\. GitHub / GitLab Benzeri Kaynak Kod Yönetimi**

Sistemde GitHub ve GitLab benzeri bir proje ve kaynak kod yönetim mantığı bulunmalıdır.

Projelerin:

* Dosyaları görüntülenebilmeli,  
* Kaynak kodları incelenebilmeli,  
* Değişiklik geçmişi takip edilebilmeli,  
* Versiyonları görüntülenebilmeli,  
* Güncellemeleri takip edilebilmelidir.

İlerleyen aşamalarda Git tabanlı versiyon kontrol sistemiyle entegrasyon veya doğrudan sistem içerisinde versiyon kontrol mekanizması değerlendirilebilir.

---

## **5\. Proje Ön İzleme Sistemi**

Bir proje görüntülendiğinde yalnızca kaynak kodlarına değil, projenin çalışan haline de erişilebilmelidir.

Kullanıcı proje detay sayfasından doğrudan:

* Projenin ön izlemesini,  
* Demo görüntüsünü,  
* Çalışan web arayüzünü

görebilmelidir.

Projenin nasıl göründüğünü görmek için ayrıca local ortamda projeyi çalıştırmak zorunda kalınmamalıdır.

---

## **6\. Simulator / Cihaz Ön İzleme Sistemi**

Ön yüz içerisinde bir **simülatör sistemi** bulunmalıdır.

Kullanıcı:

1. Görüntülemek istediği projeyi seçer.  
2. Görüntülemek istediği cihazı seçer.  
3. Projenin ilgili cihaz üzerindeki görünümünü simülatör içerisinde görüntüler.

Başlangıçta yaklaşık **15–20 farklı cihaz modeli veya ekran tipi** desteklenebilir.

Örneğin:

* Desktop  
* Laptop  
* Tablet  
* iPad  
* iPhone modelleri  
* Android telefon modelleri  
* Farklı ekran çözünürlükleri

desteklenebilir.

Simülatör gerektiğinde local ortamda çalışabilecek şekilde de tasarlanmalıdır.

---

## **7\. Deployment ve FTP Motoru**

Projelerin sunucuya aktarılabilmesi için sistem içerisinde bir deployment / FTP motoru bulunmalıdır.

Kullanıcı bir proje için:

* Local veya kaynak klasör yolu  
* Sunucu adresi  
* FTP / SFTP bilgileri  
* Kullanıcı adı  
* Şifre  
* Hedef klasör  
* API bilgileri

gibi gerekli bilgileri tanımlayabilmelidir.

Daha sonra tek bir işlemle proje ilgili sunucuya aktarılabilmelidir.

Amaç, proje yayına alma işlemlerinin mümkün olduğunca merkezi ve kolay hale getirilmesidir.

---

## **8\. Versiyon ve Güncelleme Sistemi**

Her projenin bir versiyon numarası bulunmalıdır.

Örneğin:

* v1.0.0  
* v1.1.0  
* v1.1.1  
* v2.0.0

gibi.

Yapılan her önemli güncelleme kayıt altında tutulmalıdır.

Sistem içerisinde bir **Update Modülü** bulunmalıdır.

Bir proje güncellenirken mevcut verilerin korunması önemlidir.

Özellikle database kullanan projelerde güncelleme sırasında:

* Mevcut verilerin korunması,  
* Database migration işlemleri,  
* Yeni tablolar veya kolonların eklenmesi,  
* Eski sistemle yeni sistem arasındaki veri uyumluluğu,  
* Gerekirse rollback işlemleri

yönetilebilmelidir.

---

## **9\. PostgreSQL Database**

Ana sistemin database altyapısında **PostgreSQL** kullanılacaktır.

Projelere ait bilgiler, kullanıcılar, yetkiler, versiyonlar, deployment geçmişleri, feedback kayıtları ve diğer yönetim verileri PostgreSQL üzerinde saklanacaktır.

---

## **10\. Kullanıcı ve Profil Yönetimi**

Sisteme kimlerin giriş yapabileceğini biz belirleyebilmeliyiz.

Kullanıcı yönetimi içerisinde bir profil sistemi bulunmalıdır.

Her kullanıcı için:

* Ad / soyad  
* Kullanıcı adı  
* E-posta  
* Profil bilgileri  
* Rol  
* Yetkiler  
* Erişebileceği projeler  
* İşlem geçmişi

gibi bilgiler tutulabilmelidir.

---

## **11\. Yetkilendirme Sistemi**

Detaylı bir rol ve yetki sistemi oluşturulmalıdır.

Örneğin:

* Sistem yöneticisi  
* Proje yöneticisi  
* Developer  
* Designer  
* Tester  
* Müşteri / misafir kullanıcı

gibi roller oluşturulabilir.

Her kullanıcının:

* Hangi projeyi görebileceği,  
* Kaynak kodunu görüp göremeyeceği,  
* Dosya değiştirme yetkisi,  
* Deployment yetkisi,  
* Versiyon oluşturma yetkisi,  
* Müşteri linki oluşturma yetkisi

ayrı ayrı yönetilebilmelidir.

---

## **12\. Modüler Sistem Mimarisi**

Sistem modüler olarak geliştirilmelidir.

Ana sistemden bağımsız şekilde yeni modüller eklenebilmelidir.

Örneğin:

* Proje yönetim modülü  
* Dosya yönetim modülü  
* Deployment modülü  
* Simulator modülü  
* AI analiz modülü  
* Güvenlik modülü  
* Kullanıcı yönetimi modülü  
* Versiyon yönetimi modülü  
* Feedback modülü  
* Müşteri paylaşım modülü

birbirinden ayrıştırılmalıdır.

Bu yapı gelecekte yeni özelliklerin sisteme daha kolay eklenmesini sağlayacaktır.

---

## **13\. AI Proje Asistanı / AI Bot**

Sistem içerisinde projeleri inceleyebilen bir yapay zekâ asistanı bulunmalıdır.

AI bot proje kaynak kodlarını ve proje yapısını analiz edebilmelidir.

AI aşağıdaki konularda analiz ve öneriler sunabilmelidir:

* Kod kalitesi  
* Proje mimarisi  
* Eksik yapılar  
* Hatalı kodlar  
* Güvenlik açıkları  
* Kullanılmayan kodlar  
* Performans problemleri  
* Database yapısı  
* API yapısı  
* Dosya organizasyonu  
* Güncelleme önerileri  
* Refactoring önerileri

AI yalnızca tek bir dosyayı değil, mümkün olduğunca projenin genel yapısını anlayabilmelidir.

Codex benzeri şekilde projeye erişebilmeli, proje hakkında bilgi sahibi olabilmeli ve verilen görev kapsamında gerekli dosyaları inceleyebilmelidir.

İlk aşamada AI'ın temel görevi **analiz yapmak ve öneride bulunmak** olacaktır.

İlerleyen aşamalarda kontrollü yetkilendirmeler ile AI'ın bazı işlemleri otomatik gerçekleştirebildiği daha otonom bir yapı oluşturulabilir.

---

## **14\. Güvenlik Tarama Sistemi**

Projeler belirli aralıklarla veya talep üzerine taranabilmelidir.

Sistem:

* Güvenlik açıklarını,  
* Riskli kodları,  
* Açık bırakılmış API anahtarlarını,  
* Şifreleri,  
* Güvensiz bağımlılıkları,  
* Şüpheli dosyaları,  
* Eski paketleri

tespit etmeye yardımcı olmalıdır.

AI analiz sistemi de bu güvenlik modülüyle birlikte çalışabilmelidir.

---

## **15\. Windows ve macOS Erişimi**

Sisteme hem **Windows** hem de **macOS** ortamlarından erişilebilmelidir.

Ana yapı web tabanlı olacağı için işletim sisteminden bağımsız çalışmalıdır.

Gerektiğinde local bilgisayarla sunucu arasında iletişim kurabilecek yardımcı bir uygulama / agent geliştirilebilir.

Bu agent sayesinde sistem kullanıcının bilgisayarındaki proje veya geliştirme ortamıyla kontrollü şekilde iletişim kurabilir.

---

## **16\. Uzaktan Müdahale ve Proje Yönetimi**

Merkezi sistem proje hakkında sürekli bilgi sahibi olmalıdır.

Yetkili kullanıcılar sunucu üzerinden:

* Projeyi inceleyebilmeli,  
* Dosyalara erişebilmeli,  
* Güncelleme yapabilmeli,  
* Deployment başlatabilmeli,  
* AI analizlerini çalıştırabilmeli,  
* Proje durumunu görüntüleyebilmelidir.

Yapılan tüm önemli işlemler loglanmalıdır.

---

## **17\. Müşteri İçin Geçici Demo URL Sistemi**

Müşteri veya dış kullanıcıların projeyi inceleyebilmesi için geçici URL oluşturulabilmelidir.

Örneğin:

`preview.sistem.com/abc123`

gibi geçici bir bağlantı oluşturulabilir.

Bu bağlantı için kullanıcıya hesap açılması veya login yaptırılması zorunlu olmamalıdır.

Link oluşturulurken erişim süresi belirlenebilmelidir.

Örneğin:

* 1 saat  
* 6 saat  
* 24 saat  
* Belirli tarih ve saate kadar

Linkin süresi dolduğunda otomatik olarak erişilemez hale gelmelidir.

Gerekirse yetkili kullanıcı linki manuel olarak da kapatabilmelidir.

---

## **18\. Müşteri Feedback Sistemi**

Geçici demo URL üzerinden projeyi inceleyen müşteri geri bildirim bırakabilmelidir.

Müşteri:

* İlgili sayfa hakkında yorum yazabilmeli,  
* Hata bildirebilmeli,  
* Değişiklik talep edebilmeli,  
* Gerekirse ekran / bölüm bazlı feedback bırakabilmelidir.

Bu bildirimler sistem içerisinde maddeler halinde görüntülenmelidir.

Örneğin:

1. Ana sayfadaki logo büyütülecek.  
2. Mobil menü düzeltilmeli.  
3. Ürün sayfasındaki buton değiştirilmeli.  
4. İletişim formunda hata bulunuyor.

Ekip bu maddeleri görev olarak ele alabilmeli ve gerekli **hotfix** işlemlerini gerçekleştirebilmelidir.

---

## **19\. Canlı Destek / İletişim Alanı**

Demo sayfasında isteğe bağlı bir canlı destek veya mesajlaşma alanı bulunmalıdır.

Müşteri proje hakkında ekip ile iletişim kurabilmeli ve geri bildirimlerini doğrudan ilgili proje üzerinden iletebilmelidir.

Bu konuşmalar proje içerisinde kayıt altında tutulabilmelidir.

---

## **20\. Sunucu Gereksinimi**

İlk aşamada sistem için yaklaşık:

* **8 GB RAM**  
* **200 GB disk alanı**

bulunan bir sunucu hazırlanacaktır.

Sistem mimarisi bu kaynaklar göz önünde bulundurularak tasarlanmalıdır.

Kaynak tüketimi yüksek servisler mümkün olduğunca optimize edilmeli, AI işlemleri ve simulator gibi ağır servisler gerektiğinde ayrı servisler olarak çalıştırılabilecek şekilde planlanmalıdır.

---

## **Nihai Hedef**

Projenin uzun vadeli hedefi yalnızca bir kaynak kod deposu oluşturmak değildir.

Sistem zaman içerisinde şirketin bütün yazılım projelerini tanıyan ve yöneten merkezi bir **Project Hub / Development Hub** haline gelmelidir.

Tek bir platform üzerinden:

**Proje → Kaynak Kod → Ön İzleme → Simulator → Versiyon → Deployment → Güncelleme → Güvenlik → AI Analizi → Müşteri Feedback → Hotfix → Arşiv**

sürecinin tamamı yönetilebilmelidir.

