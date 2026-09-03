/**
 * A14 (2.6.8), David: a folder under ~/Desktop, ~/Documents or ~/Downloads
 * makes macOS ask for access the first time LU walks it. That dialog is the
 * system asking on the user's behalf and nothing may prevent it; what the
 * panel can do is stop it from arriving as a surprise from an app that just
 * started reading a folder.
 *
 * The rule is deliberately narrow. A note that fires everywhere is a note
 * nobody reads, and a note on Windows would be a claim about an operating
 * system that never asks.
 *
 * Run: npx vitest run src/lib/__tests__/macos-folder-access-note.test.ts
 */
import { describe, it, expect } from 'vitest'
import { macOsWillAskForFolder, MACOS_FOLDER_ACCESS_NOTE } from '../model-storage-rows'

const MAC = true
const NOT_MAC = false

describe('the three folders macOS gates', () => {
  it('fires for the folder itself', () => {
    expect(macOsWillAskForFolder('/Users/david/Desktop', MAC)).toBe(true)
    expect(macOsWillAskForFolder('/Users/david/Documents', MAC)).toBe(true)
    expect(macOsWillAskForFolder('/Users/david/Downloads', MAC)).toBe(true)
  })

  it('fires for anything inside one of them, however deep', () => {
    expect(macOsWillAskForFolder('/Users/david/Desktop/LU/models', MAC)).toBe(true)
    expect(macOsWillAskForFolder('/Users/david/Documents/ai/gguf/chat', MAC)).toBe(true)
  })

  it('does not care how the folder is spelled', () => {
    expect(macOsWillAskForFolder('/Users/david/desktop/models', MAC)).toBe(true)
    expect(macOsWillAskForFolder('/Users/david/DOWNLOADS/', MAC)).toBe(true)
  })

  it('is one sentence and says the asking is done once, by the system', () => {
    expect(MACOS_FOLDER_ACCESS_NOTE).toBe('macOS will ask once for access to this folder.')
  })
})

describe('NEGATIVE CONTROLS: where the note must stay away', () => {
  // The whole point of the note is that it marks these three folders. A note
  // on every folder marks nothing.
  it('an ordinary folder in the home directory', () => {
    expect(macOsWillAskForFolder('/Users/david/AI/models', MAC)).toBe(false)
    expect(macOsWillAskForFolder('/Users/david', MAC)).toBe(false)
  })

  it('an external drive, even one with a folder named Documents on it', () => {
    expect(macOsWillAskForFolder('/Volumes/T7/Documents/models', MAC)).toBe(false)
    expect(macOsWillAskForFolder('/Volumes/T7/models', MAC)).toBe(false)
  })

  it('a deeper folder that merely happens to be called Desktop', () => {
    expect(macOsWillAskForFolder('/Users/david/AI/Desktop/models', MAC)).toBe(false)
  })

  // Windows and Linux never ask. Printing the sentence there would be a claim
  // about the wrong operating system, and the app ships on all three.
  it('Windows and Linux, where nothing asks', () => {
    expect(macOsWillAskForFolder('/Users/david/Desktop/models', NOT_MAC)).toBe(false)
    expect(macOsWillAskForFolder('C:\\Users\\david\\Desktop\\models', NOT_MAC)).toBe(false)
    expect(macOsWillAskForFolder('/home/david/Desktop/models', NOT_MAC)).toBe(false)
  })

  it('an empty field, which names no folder at all', () => {
    expect(macOsWillAskForFolder('', MAC)).toBe(false)
    expect(macOsWillAskForFolder('   ', MAC)).toBe(false)
    expect(macOsWillAskForFolder(null, MAC)).toBe(false)
    expect(macOsWillAskForFolder(undefined, MAC)).toBe(false)
  })
})
