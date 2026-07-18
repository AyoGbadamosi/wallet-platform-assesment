export const OWNER_NAMES = [
  'Ama Owusu',
  'Kwame Mensah',
  'Efua Asante',
  'Kofi Boateng',
  'Akosua Darko',
  'Yaw Appiah',
  'Abena Osei',
  'Kwabena Agyei',
  'Adjoa Sarpong',
  'Kojo Amankwah',
  'Esi Gyamfi',
  'Kwesi Frimpong',
  'Afia Nkrumah',
  'Kwadwo Adjei',
  'Yaa Antwi',
  'Fiifi Quaye',
  'Abla Tetteh',
  'Nana Yeboah',
  'Adwoa Kusi',
  'Ebo Aidoo',
];

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}
