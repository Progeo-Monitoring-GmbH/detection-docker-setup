/** The company behind the portal - login page, privacy policy, ... */
export const COMPANY = {
  name: 'ProGeo Monitoring Systeme und Services GmbH & Co. KG',
  street: 'Hauptstraße 2',
  postalCity: 'DE-14979 Großbeeren',
  phone: '+49 33701 22-0',
  fax: '+49 33701 22-119',
  email: 'kontakt@progeo.com',
};

/** A phone number as tel: link target ("+49 33701 22-0" -> "+4933701220"). */
export const telHref = (number: string) => `tel:${number.replace(/[^\d+]/g, '')}`;
