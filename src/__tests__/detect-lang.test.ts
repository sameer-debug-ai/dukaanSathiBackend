import { detectReplyLang } from '../ai/detectLang';

describe('detectReplyLang', () => {
  it('answers in Hindi for Devanagari and Hinglish', () => {
    expect(detectReplyLang('इस महीने का कितना उधार है', 'en')).toBe('hi');
    expect(detectReplyLang('Sharma ji ka kitna udhaar hai?', 'en')).toBe('hi');
    expect(detectReplyLang('Sharma ji ke udhaar me 500 add krdo', 'en')).toBe('hi');
    expect(detectReplyLang('kya kya khatam ho gaya', 'en')).toBe('hi');
  });

  it('answers in English for English, even with Indian names and "udhaar"', () => {
    expect(detectReplyLang('How much does Sharma ji owe?', 'hi')).toBe('en');
    expect(detectReplyLang('add 500 to Sharma ji udhaar', 'hi')).toBe('en');
    expect(detectReplyLang('which items are out of stock', 'hi')).toBe('en');
    expect(detectReplyLang('Sharma ji paid 300 rupees', 'hi')).toBe('en');
  });

  it('falls back to the app language when it cannot tell', () => {
    expect(detectReplyLang('Gupta ji', 'hi')).toBe('hi');
    expect(detectReplyLang('Gupta ji', 'en')).toBe('en');
  });
});
