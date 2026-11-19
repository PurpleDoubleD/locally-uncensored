// metal-shader-check.m — compile llama.cpp's embedded Metal sources with the
// Metal compiler of the macOS this runs on (A40, GH #259, 3.1.2).
//
// The Mac sidecar embeds its shaders as SOURCE (GGML_METAL_EMBED_LIBRARY).
// They are compiled on the user's Mac, by the compiler that ships inside that
// macOS, through the same call llama.cpp makes (newLibraryWithSource). b11960
// carried two constexpr bfloat casts that the compiler of macOS 26 accepts and
// the one of macOS 14 and 15 refuses, so no model loaded there and nothing in
// the release lane noticed. This program makes that same call on a runner of
// the oldest macOS LU supports, before a build ships.
//
// usage: metal-shader-check <bf16 0|1> <file.metal>...
//   bf16 1 sets GGML_METAL_HAS_BF16, as llama.cpp does on every Apple Silicon
//   GPU (has_bfloat), which is the branch that broke. The tensor API stays
//   off: it needs Metal 4, so a Mac below macOS 26 never compiles it.
// Exit 0 when every file compiles, 1 when one does not, 2 when this machine
// has no Metal device (then nothing was checked, which must not read as a
// pass).

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

int main(int argc, char ** argv) {
    @autoreleasepool {
        if (argc < 3) {
            fprintf(stderr, "usage: %s <bf16 0|1> <file.metal>...\n", argv[0]);
            return 2;
        }
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (device == nil) {
            fprintf(stderr, "FAIL: no Metal device on this machine, nothing was compiled\n");
            return 2;
        }
        const bool bf16 = atoi(argv[1]) != 0;
        printf("device: %s, GGML_METAL_HAS_BF16=%s\n", [[device name] UTF8String], bf16 ? "1" : "unset");

        int failures = 0;
        for (int i = 2; i < argc; i++) {
            NSError * error = nil;
            NSString * src = [NSString stringWithContentsOfFile:@(argv[i]) encoding:NSUTF8StringEncoding error:&error];
            if (src == nil) {
                fprintf(stderr, "FAIL %s: cannot read it\n", argv[i]);
                failures++;
                continue;
            }
            NSMutableDictionary * prep = [NSMutableDictionary dictionary];
            prep[@"GGML_METAL_EMBED_LIBRARY"] = @"1";
            if (bf16) {
                prep[@"GGML_METAL_HAS_BF16"] = @"1";
            }
            MTLCompileOptions * options = [MTLCompileOptions new];
            options.preprocessorMacros = prep;
            // No languageVersion: llama.cpp leaves it at the system default
            // unless the tensor API is on, and so does this check.
            error = nil;
            id<MTLLibrary> lib = [device newLibraryWithSource:src options:options error:&error];
            if (lib == nil) {
                fprintf(stderr, "FAIL %s\n%s\n", argv[i], [[error localizedDescription] UTF8String]);
                failures++;
            } else {
                printf("ok   %s\n", argv[i]);
            }
        }
        printf("%d of %d compiled\n", argc - 2 - failures, argc - 2);
        return failures == 0 ? 0 : 1;
    }
}
