//go:build cgo && !dilithium_circl

package crypto

import (
	"testing"

	"github.com/cloudflare/circl/sign/mldsa/mldsa87"
)

func TestLibOQSVerifyValidatesInput(t *testing.T) {
	verifier := NewDilithiumVerifyOnly()
	if verifier == nil {
		t.Fatal("liboqs ML-DSA-87 verifier is unavailable")
	}
	defer verifier.Free()

	publicKey, privateKey := mldsa87.NewKeyFromSeed(&[mldsa87.SeedSize]byte{1})
	packed := publicKey.Bytes()
	signature := make([]byte, mldsa87.SignatureSize)
	if err := mldsa87.SignTo(privateKey, nil, nil, false, signature); err != nil {
		t.Fatal(err)
	}
	if ok, err := verifier.VerifyWithPublicKey(nil, signature, packed); !ok || err != nil {
		t.Fatalf("valid signature for empty message: ok=%v err=%v", ok, err)
	}

	verifier.pk = packed
	if ok, err := verifier.Verify([]byte("test message"), nil); ok || err == nil {
		t.Fatalf("missing signature: ok=%v err=%v", ok, err)
	}
	if ok, err := verifier.VerifyWithPublicKey(nil, signature[:len(signature)-1], packed); ok || err == nil {
		t.Fatalf("short signature: ok=%v err=%v", ok, err)
	}
	if ok, err := verifier.VerifyWithPublicKey(nil, signature, nil); ok || err == nil {
		t.Fatalf("missing public key: ok=%v err=%v", ok, err)
	}
}
